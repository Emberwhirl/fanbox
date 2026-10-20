param([int]$Seconds = 360)
# Read-only context for frame measurements. Never sends input or changes policy.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FanboxFrameDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint size, time; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref INPUT data);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder text, int length, out int needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  public static uint Idle() { var i = new INPUT(); i.size=(uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return unchecked((uint)Environment.TickCount-i.time); }
  public static bool Screensaver() { bool value; return SystemParametersInfo(0x72,0,out value,0) && value; }
  public static string Desktop() { var h=OpenInputDesktop(0,false,1); if(h==IntPtr.Zero)return "unavailable"; try { var b=new StringBuilder(256); int n; return GetUserObjectInformation(h,2,b,512,out n)?b.ToString():"unknown"; } finally { CloseDesktop(h); } }
}
'@
for ($taskElapsed = 0; $taskElapsed -le $Seconds; $taskElapsed += 5) {
  [pscustomobject]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); idleSeconds = [Math]::Round([FanboxFrameDesktop]::Idle()/1000, 1); screensaver = [FanboxFrameDesktop]::Screensaver(); desktop = [FanboxFrameDesktop]::Desktop() } | ConvertTo-Json -Compress
  Start-Sleep -Seconds 5
}
