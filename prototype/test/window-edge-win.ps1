param([long]$Handle, [int]$Distance = 0, [string]$Screenshot = '')

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class SpanWindowEdge {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@

$null = [SpanWindowEdge]::SetProcessDPIAware()
$window = [IntPtr]$Handle
$rect = New-Object SpanWindowEdge+Rect
if (-not [SpanWindowEdge]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot find the test window.' }

if ($Screenshot) {
    Add-Type -AssemblyName System.Drawing
    $bitmap = [Drawing.Bitmap]::new(($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
        $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
    exit
}

$y = $rect.Top + [int](($rect.Bottom - $rect.Top) / 2)
$x = 0
for ($edge = $rect.Right - 1; $edge -ge $rect.Right - 16; $edge--) {
    $point = [IntPtr]([long](($y -band 65535) * 65536 + ($edge -band 65535)))
    # WM_NCHITTEST should identify the right non-client resize edge as HTRIGHT.
    $hit = [SpanWindowEdge]::SendMessageW($window, 0x84, [IntPtr]::Zero, $point)
    if ($hit.ToInt64() -eq 11) {
        $x = $edge
        break
    }
}
if (-not $x) { throw 'Cannot reach the right resize edge of the test window.' }

$null = [SpanWindowEdge]::SetCursorPos($x, $y)
[SpanWindowEdge]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
try {
    Start-Sleep -Milliseconds 45
    for ($step = 1; $step -le 6; $step++) {
        $null = [SpanWindowEdge]::SetCursorPos($x + [int]($Distance * $step / 6), $y)
        Start-Sleep -Milliseconds 45
    }
} finally {
    [SpanWindowEdge]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
