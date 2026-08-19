<#
.SYNOPSIS
  Sends a file's raw bytes straight to a named Windows printer, bypassing
  GDI rendering entirely (datatype "RAW"). This is how ESC/POS (receipt)
  and ZPL (label) commands reach thermal/label printers — those printers
  interpret the byte stream directly as commands, not as a page to render.

  Classic technique (P/Invoke into winspool.drv), the same pattern behind
  Microsoft's long-standing "RawPrinterHelper" C# sample (KB Q322091),
  rewritten here in PowerShell so the Electron app doesn't need a compiled
  native Node addon (node-gyp/Visual Studio build tools) just for this —
  keeps the desktop app's dependency footprint low, matching the
  "maintainability over years" priority from the original requirements.

.NOTES
  Invoked from services/printing/raw-print.ts via child_process, passing
  the printer name and a path to a temp file containing the exact bytes to
  send (never passed as a command-line argument — binary ESC/POS/ZPL data
  can contain bytes that are unsafe or lossy to round-trip through shell
  argument encoding).
#>
param(
    [Parameter(Mandatory = $true)][string]$PrinterName,
    [Parameter(Mandatory = $true)][string]$FilePath
)

$ErrorActionPreference = "Stop"

Add-Type -Namespace RawPrint -Name Helper -MemberDefinition @"
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
}

[DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

[DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
public static extern bool ClosePrinter(IntPtr hPrinter);

[DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
public static extern bool StartDocPrinter(IntPtr hPrinter, int level, DOCINFOA di);

[DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
public static extern bool EndDocPrinter(IntPtr hPrinter);

[DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
public static extern bool StartPagePrinter(IntPtr hPrinter);

[DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
public static extern bool EndPagePrinter(IntPtr hPrinter);

[DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
"@

$bytes = [System.IO.File]::ReadAllBytes($FilePath)

$hPrinter = [IntPtr]::Zero
if (-not [RawPrint.Helper]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
    throw "OpenPrinter failed for '$PrinterName' (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

try {
    $di = New-Object RawPrint.Helper+DOCINFOA
    $di.pDocName = "ProjectRD Desktop"
    $di.pDataType = "RAW"

    if (-not [RawPrint.Helper]::StartDocPrinter($hPrinter, 1, $di)) {
        throw "StartDocPrinter failed (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }

    try {
        if (-not [RawPrint.Helper]::StartPagePrinter($hPrinter)) {
            throw "StartPagePrinter failed (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        }

        $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        try {
            [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
            $written = 0
            $ok = [RawPrint.Helper]::WritePrinter($hPrinter, $ptr, $bytes.Length, [ref]$written)
            if (-not $ok -or $written -ne $bytes.Length) {
                throw "WritePrinter failed or incomplete: wrote $written of $($bytes.Length) bytes (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
            }
        }
        finally {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
        }

        [RawPrint.Helper]::EndPagePrinter($hPrinter) | Out-Null
    }
    finally {
        [RawPrint.Helper]::EndDocPrinter($hPrinter) | Out-Null
    }
}
finally {
    [RawPrint.Helper]::ClosePrinter($hPrinter) | Out-Null
}

Write-Output "OK"
