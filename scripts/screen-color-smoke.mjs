import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { closeToolWindow, keepSuggestedColorSchemeName, openOptionsWindow } from "./tool-window-smoke.mjs";

const run = promisify(execFile);
const command = (script) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64")];

export async function testScreenColor(page) {
  const painter = spawn("powershell.exe", command(`
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName PresentationFramework
    $window = [Windows.Window]::new()
    $window.Title = 'Dirlume screen color fixture'
    $window.Width = 200
    $window.Height = 130
    $window.Left = 5
    $window.Top = 40
    $window.WindowStyle = 'None'
    $window.ResizeMode = 'NoResize'
    $window.Topmost = $true
    $window.ShowActivated = $false
    $brush = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(36, 89, 120))
    $window.Background = $brush
    $surface = [Windows.Controls.Border]::new()
    $surface.Background = $brush
    $window.Content = $surface
    $window.Show()
    [Console]::WriteLine(('ready {0}' -f [Windows.Interop.WindowInteropHelper]::new($window).Handle.ToInt64()))
    [Console]::Out.Flush()
    [Windows.Threading.Dispatcher]::Run()
  `), { windowsHide: true });
  let output = "";
  const windowHandle = new Promise((resolve, reject) => {
    painter.once("error", reject);
    painter.once("exit", (code) => reject(new Error(`The screen color fixture stopped (${code}). ${output}`)));
    painter.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/ready (\d+)\r?\n/);
      if (match) resolve(match[1]);
    });
    painter.stderr.on("data", (chunk) => { output += chunk; });
  });
  let timeout;
  try {
    const fixtureHandle = await Promise.race([windowHandle, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`The external color window did not open. ${output}`)), 20000);
    })]);
    clearTimeout(timeout);
    const tool = await openOptionsWindow(page);
    const options = tool.getByRole("dialog", { name: "Options", exact: true });
    await options.getByRole("button", { name: "Viewer", exact: true }).click();
    await options.getByRole("button", { name: "Block background color", exact: true }).click();
    const color = tool.getByRole("dialog", { name: "Block background color", exact: true });
    const hex = color.getByRole("textbox", { name: "HEX", exact: true });
    const previous = await hex.inputValue();
    const eyedropper = color.getByRole("button", { name: "Pick a color from the screen", exact: true });
    const hint = color.getByText("Click a visible color anywhere on the screen. Press Esc to cancel.", { exact: true });
    const input = (action) => run("powershell.exe", command(`
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      Add-Type @"
        using System.Runtime.InteropServices;
        public static class SampleInput {
          [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
          [StructLayout(LayoutKind.Sequential)] public struct CursorInfo {
            public int Size; public int Flags; public System.IntPtr Cursor; public Point Position;
          }
          [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CursorInfo info);
          [DllImport("user32.dll", EntryPoint = "LoadCursorW")] public static extern System.IntPtr LoadCursor(System.IntPtr module, System.IntPtr id);
          [DllImport("user32.dll")] public static extern bool SetPhysicalCursorPos(int x, int y);
          [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out Point point);
          [DllImport("user32.dll")] public static extern System.IntPtr WindowFromPhysicalPoint(Point point);
          [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(System.IntPtr window, System.Text.StringBuilder name, int length);
          [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] public static extern System.IntPtr GetClassLongPtr(System.IntPtr window, int index);
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint process);
          [DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr context);
          [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr window, System.IntPtr after, int x, int y, int width, int height, uint flags);
          [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, System.UIntPtr extra);
          [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, System.UIntPtr extra);
        }
"@
      $null = [SampleInput]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
      function Assert-Crosshair([bool]$expected) {
        $info = New-Object SampleInput+CursorInfo
        $info.Size = [Runtime.InteropServices.Marshal]::SizeOf([type][SampleInput+CursorInfo])
        $crosshair = [SampleInput]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32515))
        $point = New-Object SampleInput+Point
        $name = [System.Text.StringBuilder]::new(128)
        $cursorSuppressed = 2
        $classCursorIndex = -12
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
          if ($expected -and ![SampleInput]::SetPhysicalCursorPos((102 + ($attempt % 2)), 152)) {
            throw 'Could not move the pointer over the external application.'
          }
          if ([SampleInput]::GetCursorInfo([ref]$info) -and [SampleInput]::GetPhysicalCursorPos([ref]$point)) {
            $hit = [SampleInput]::WindowFromPhysicalPoint($point)
            $null = $name.Clear()
            $null = [SampleInput]::GetClassName($hit, $name, $name.Capacity)
            $sampling = $name.ToString() -eq 'Dirlume.ScreenSampler'
            if (!$expected -and !$sampling -and $info.Cursor -ne $crosshair) { return }
            if ($expected -and $sampling -and [SampleInput]::GetClassLongPtr($hit, $classCursorIndex) -eq $crosshair) {
              if ($info.Cursor -eq $crosshair) { return }
              # Windows omits the global cursor handle while drawing is suppressed.
              if (($info.Flags -band $cursorSuppressed) -ne 0) {
                [Console]::WriteLine('Verified the sampler crosshair class while Windows suppressed the visible system cursor.')
                return
              }
            }
          }
          Start-Sleep -Milliseconds 30
        }
        throw "Expected crosshair=$expected at ($($point.X), $($point.Y)); window class=$name, cursor=$($info.Cursor), flags=$($info.Flags), crosshair=$crosshair."
      }
      ${action === "place" ? `
        $fixture = [IntPtr]::new([long]${fixtureHandle})
        [uint32]$owner = 0
        $null = [SampleInput]::GetWindowThreadProcessId($fixture, [ref]$owner)
        if ($owner -ne ${painter.pid}) { throw "Could not find the external color window." }
        if (![SampleInput]::SetWindowPos($fixture, [IntPtr]::new(-1), 20, 100, 175, 125, 0x50)) { throw "Could not reveal the external color window." }
        if (![SampleInput]::SetPhysicalCursorPos(100, 150)) { throw "Could not place the test pointer." }
        $point = New-Object SampleInput+Point
        $null = [SampleInput]::GetPhysicalCursorPos([ref]$point)
        $null = [SampleInput]::GetWindowThreadProcessId([SampleInput]::WindowFromPhysicalPoint($point), [ref]$owner)
        if ($owner -ne ${painter.pid}) { throw "The external color window is covered." }
        Assert-Crosshair $false
      ` : action === "click" ? `
        Assert-Crosshair $true
        [SampleInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [SampleInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      ` : action === "escape" ? `
        Assert-Crosshair $true
        [SampleInput]::keybd_event(27, 0, 0, [UIntPtr]::Zero)
        [SampleInput]::keybd_event(27, 0, 2, [UIntPtr]::Zero)
      ` : `
        Assert-Crosshair $false
      `}
    `), { windowsHide: true }).catch((error) => { throw new Error((error.stderr || error.message).slice(-1100)); });
    await input("place");
    await eyedropper.click();
    await hint.waitFor();
    const escape = await input("escape");
    await hint.waitFor({ state: "hidden" });
    assert.equal(await hex.inputValue(), previous);
    await input("restored");

    await eyedropper.click();
    await hint.waitFor();
    const click = await input("click");
    await hint.waitFor({ state: "hidden" });
    assert.equal(await hex.inputValue(), "#245978");
    await input("restored");
    await color.locator('[data-tooltip="Selected color #245978"]').waitFor();
    await color.getByRole("button", { name: "Use color", exact: true }).click();
    assert.equal(await options.getByRole("textbox", { name: "Block background hex", exact: true }).inputValue(), "#245978");
    await closeToolWindow(tool, async () => {
      await options.getByRole("button", { name: "Done", exact: true }).click();
      await keepSuggestedColorSchemeName(tool);
    });
    for (const result of [escape, click]) {
      if (result.stdout.trim()) console.log(result.stdout.trim());
    }
    console.log("Verified the sampling overlay over an external Windows application, color sampling, and restoration after Esc and selection.");
  } finally {
    clearTimeout(timeout);
    if (painter.exitCode === null) {
      const exited = once(painter, "exit").catch(() => {});
      painter.kill();
      await exited;
    }
  }
}
