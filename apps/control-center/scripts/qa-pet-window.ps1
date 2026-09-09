param([Parameter(Mandatory)][int]$OwnerPid, [ValidateSet('inspect', 'drag', 'close')][string]$Action = 'inspect')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PetWindowProbe {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetStyle(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static long Find(uint owner) {
    long found = 0;
    EnumWindows((h,p) => { uint pid; GetWindowThreadProcessId(h, out pid);
      if(pid == owner) { var b = new StringBuilder(128); GetWindowText(h,b,b.Capacity); if(b.ToString() == "514 Pet") found = h.ToInt64(); }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[void][PetWindowProbe]::SetProcessDPIAware()
$petHandle = [PetWindowProbe]::Find($OwnerPid)
if (!$petHandle) { '{"exists":false}'; exit 0 }
$petRect = New-Object PetWindowProbe+Rect
[void][PetWindowProbe]::GetWindowRect([intptr]$petHandle, [ref]$petRect)
if ($Action -eq 'drag') {
  $petCursor = New-Object PetWindowProbe+Point
  [void][PetWindowProbe]::GetCursorPos([ref]$petCursor)
  try {
    [void][PetWindowProbe]::SetForegroundWindow([intptr]$petHandle)
    [void][PetWindowProbe]::SetCursorPos($petRect.Left + 45, $petRect.Top + 14)
    [PetWindowProbe]::mouse_event(2, 0, 0, 0, [uintptr]::Zero)
    Start-Sleep -Milliseconds 500
    for ($petStep=1; $petStep -le 10; $petStep++) {
      [void][PetWindowProbe]::SetCursorPos($petRect.Left + 45 - [int](12.5 * $petStep), $petRect.Top + 14 - [int](7.9 * $petStep))
      Start-Sleep -Milliseconds 30
    }
  } finally {
    [PetWindowProbe]::mouse_event(4, 0, 0, 0, [uintptr]::Zero)
    Start-Sleep -Milliseconds 200
    [void][PetWindowProbe]::SetCursorPos($petCursor.X, $petCursor.Y)
  }
} elseif ($Action -eq 'close') {
  [void][PetWindowProbe]::PostMessage([intptr]$petHandle, 0x10, [intptr]::Zero, [intptr]::Zero)
}
[void][PetWindowProbe]::GetWindowRect([intptr]$petHandle, [ref]$petRect)
$petStyle = [PetWindowProbe]::GetStyle([intptr]$petHandle, -20)
[ordered]@{ exists=$true; visible=[PetWindowProbe]::IsWindowVisible([intptr]$petHandle); x=$petRect.Left; y=$petRect.Top; width=$petRect.Right-$petRect.Left; height=$petRect.Bottom-$petRect.Top; clickThrough=($petStyle -band 0x20) -ne 0; topmost=($petStyle -band 0x8) -ne 0 } | ConvertTo-Json -Compress
