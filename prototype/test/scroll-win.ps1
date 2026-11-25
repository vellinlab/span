param([long]$Handle, [int]$X, [int]$Y, [int]$Width, [int]$Height)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assemblies = @([Drawing.Bitmap].Assembly.Location, [Diagnostics.Process].Assembly.Location)
Add-Type -ReferencedAssemblies $assemblies -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class SpanScroll : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, int data, UIntPtr extra);
    [DllImport("winmm.dll")] private static extern uint timeBeginPeriod(uint milliseconds);
    [DllImport("winmm.dll")] private static extern uint timeEndPeriod(uint milliseconds);

    private readonly IntPtr window;
    private readonly Point origin;
    private readonly Bitmap bitmap;
    private readonly Graphics graphics;
    private readonly Rectangle area;
    private readonly byte[] pixels;

    public SpanScroll(long handle, int x, int y, int width, int height) {
        SetProcessDPIAware();
        window = new IntPtr(handle);
        Point point = new Point { X = x, Y = y };
        if (!ClientToScreen(window, ref point)) throw new InvalidOperationException("Cannot locate the Span client area.");
        origin = point;
        area = new Rectangle(0, 0, width, height);
        bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb);
        graphics = Graphics.FromImage(bitmap);
        pixels = new byte[width * height * 4];
    }

    public void Position() {
        if (GetForegroundWindow() != window ||
            !SetCursorPos(origin.X + area.Width / 2, origin.Y + area.Height / 2)) {
            throw new InvalidOperationException("Span must be the foreground window for native wheel input.");
        }
    }

    public string Frame() {
        graphics.CopyFromScreen(origin.X, origin.Y, 0, 0, area.Size);
        var data = bitmap.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try {
            Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
        } finally {
            bitmap.UnlockBits(data);
        }
        // Hash the screen region without writing images or sending the pixels through the harness.
        ulong hash = 14695981039346656037UL;
        unchecked {
            for (int offset = 0; offset < pixels.Length; offset += 4) {
                hash ^= (uint)(pixels[offset] | pixels[offset + 1] << 8 | pixels[offset + 2] << 16);
                hash *= 1099511628211UL;
            }
        }
        return hash.ToString("X16");
    }

    public void Wheel(int direction) {
        mouse_event(0x0800, 0, 0, -direction * 120, UIntPtr.Zero);
    }

    public static object Cpu() {
        double? compositor = null;
        using (var current = Process.GetCurrentProcess()) {
            foreach (var process in Process.GetProcessesByName("dwm")) {
                using (process) {
                    try {
                        if (process.SessionId == current.SessionId) {
                            compositor = process.TotalProcessorTime.TotalMilliseconds;
                        }
                    } catch (System.ComponentModel.Win32Exception) {
                        // Some Windows runner sessions restrict access to the compositor.
                    }
                }
            }
            return new { driver = current.TotalProcessorTime.TotalMilliseconds, compositor };
        }
    }

    public object Observe(string target, int direction, int count, int interval) {
        Position();
        string start = Frame();
        if (start == target) throw new InvalidOperationException("The wheel target must differ from the starting pixels.");
        string previous = start;
        int issued = 0, changed = 0, captures = 0;
        double? first = null, expected = null;
        var sent = new double[count];
        var clock = Stopwatch.StartNew();
        Action<int> dispatch = index => {
            sent[index] = clock.Elapsed.TotalMilliseconds;
            Wheel(direction);
            Volatile.Write(ref issued, index + 1);
        };
        Thread input = null;
        bool highResolution = count > 1 && timeBeginPeriod(1) == 0;
        try {
            if (count == 1) {
                dispatch(0);
            } else {
                // Desktop capture can block on composition. Keep it off the wheel's dispatch path.
                input = new Thread(() => {
                    dispatch(0);
                    for (int index = 1; index < count; index++) {
                        double due = sent[0] + index * interval;
                        while (clock.Elapsed.TotalMilliseconds < due) Thread.Sleep(1);
                        dispatch(index);
                    }
                });
                input.Start();
            }
            while (true) {
                string frame = Frame();
                double captured = clock.Elapsed.TotalMilliseconds;
                captures++;
                if (frame != previous) {
                    changed++;
                    previous = frame;
                }
                int delivered = Volatile.Read(ref issued);
                if (delivered > 0 && captured >= sent[0] && frame != start && !first.HasValue) first = captured - sent[0];
                if (delivered == count && captured >= sent[count - 1]) {
                    if (frame == target) {
                        expected = captured - sent[count - 1];
                        break;
                    }
                    if (captured - sent[count - 1] >= 700) break;
                }
                Thread.Sleep(5);
            }
        } finally {
            if (input != null) input.Join();
            if (highResolution) timeEndPeriod(1);
        }
        return new { first, expected, captures, changed, sent, frame = previous };
    }

    public void Dispose() {
        graphics.Dispose();
        bitmap.Dispose();
    }
}
'@

$driver = [SpanScroll]::new($Handle, $X, $Y, $Width, $Height)
try {
    [Console]::WriteLine('"ready"')
    while ($null -ne ($line = [Console]::ReadLine())) {
        $command, $target, $direction, $count, $interval = $line.Split(' ')
        $result = switch ($command) {
            'position' { $driver.Position(); 'positioned' }
            'frame' { $driver.Frame() }
            'cpu' { [SpanScroll]::Cpu() }
            'wheel' { $driver.Wheel([int]$target); 'sent' }
            'observe' { $driver.Observe($target, [int]$direction, [int]$count, [int]$interval) }
            default { throw "Unknown driver command $command" }
        }
        [Console]::WriteLine((ConvertTo-Json -InputObject $result -Compress))
    }
} finally {
    $driver.Dispose()
}
