// DARKROOM OS: Datacenter path watcher (tray app)
//
// Watches the Windows clipboard for a path starting with \\DATACENTER\.
//
//   - Copied from Explorer (explorer.exe) -> a tiny two-item popup menu
//     appears right at the mouse cursor: "Ostavi kao putanju" (do
//     nothing — the plain path is already on the clipboard, exactly what
//     Photoshop/3ds Max/Explorer's own address bar need) or "Pripremi za
//     Discord" (rewrites the clipboard into a ```-fenced code block).
//     Ignoring the popup (click elsewhere, Escape, or just leave it — it
//     auto-closes after a few seconds) leaves the plain path untouched,
//     so a copy-and-paste-elsewhere workflow is never silently mangled.
//     (An earlier version auto-rewrote *every* Explorer copy into a
//     Discord block with no choice at all, which broke exactly those
//     other paste targets — don't reintroduce that.)
//   - Copied from anywhere else (most commonly: clicking the copy button
//     on a Discord code block) -> consuming intent. Immediately opens that
//     path in File Explorer. No popup needed here since nobody copies a
//     path out of Discord for any reason other than wanting to get to
//     that folder.
//   - Left-click the tray icon at any time -> same "Pripremi za Discord"
//     rewrite, applied to whatever's currently on the clipboard. Kept as a
//     fallback for when the popup was dismissed/missed and you want to
//     wrap the last-copied path after the fact.
//   - Pressing Ctrl+V while Discord is the focused (foreground) window ->
//     if the clipboard currently holds a plain \\DATACENTER\ path, it's
//     swapped for the ```-fenced version just long enough for that one
//     paste to pick it up, then quietly restored a moment later. This is
//     the no-extra-click path: copy normally, switch to Discord, paste
//     normally — the destination decides the formatting, not a click
//     beforehand. Pasting that same clipboard content into anything other
//     than Discord is completely unaffected, since the swap only ever
//     happens while Discord itself is focused.
//
//     This needs a system-wide low-level keyboard hook (WH_KEYBOARD_LL) to
//     see Ctrl+V before it reaches the app. That specific API is also what
//     real keyloggers use, so it's a known antivirus/EDR flagging pattern —
//     unlike everything else in this file, there's a real chance this
//     specific piece gets flagged even though it does nothing with any key
//     other than reacting to Ctrl+V. The popup and tray-click paths above
//     stay in place as a fallback if that happens on some machine.
//
// So: copy a path in Explorer — either pick "Pripremi za Discord" from the
// popup, or just switch to Discord and paste normally, both work. Receiving
// end: click Discord's copy button once, Explorer opens.
//
// Deliberately simple and boring otherwise: no browser, no custom URL
// protocol, no PowerShell, no admin rights, no network calls — just a
// clipboard listener (AddClipboardFormatListener, a standard Win32 API)
// and Process.Start on explorer.exe, the same thing double-clicking a
// folder shortcut does. This exists because the earlier attempt at "a
// clickable Discord link that opens Explorer" hit two walls no
// implementation trick gets around: browsers always show a confirmation
// dialog before handing off to any non-http(s) protocol, and antivirus/EDR
// software flags exactly that browser-triggers-local-execution pattern
// (even Windows' own search-ms: protocol, once a documented phishing
// vector, now gets flagged too). Moving the trigger out of the browser
// entirely sidesteps both.
//
// Autostart: this .exe itself doesn't register anything — Setup.cs (built
// as DarkroomPathWatcherSetup.exe, see README) is what installs it and
// drops the Startup-folder shortcut. Running this .exe directly is fine
// for testing, but does so as a one-off with no autostart.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DarkroomPathWatcher
{
    internal class HiddenListenerForm : Form
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool AddClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetClipboardOwner();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int VK_CONTROL = 0x11;
        private const int VK_V = 0x56;
        private const int WM_CLIPBOARDUPDATE = 0x031D;
        private const string PathPrefix = @"\\DATACENTER\";
        private const string IdleTooltip = "Darkroom — pratilac putanja";
        private const string WrappedTooltip = "Spremno za Discord — nalepi (Ctrl+V)";

        private readonly NotifyIcon trayIcon;
        private readonly Icon appIcon;
        private readonly LowLevelKeyboardProc keyboardProc;
        private IntPtr keyboardHookId = IntPtr.Zero;
        private string lastSeenText;

        public HiddenListenerForm()
        {
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            Opacity = 0;
            StartPosition = FormStartPosition.Manual;
            Location = new System.Drawing.Point(-2000, -2000);
            Load += (s, e) => Hide();

            string iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "darkroom32.ico");
            appIcon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;

            trayIcon = new NotifyIcon
            {
                Icon = appIcon,
                Text = IdleTooltip,
                Visible = true
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add("Izađi", null, (s, e) => Application.Exit());
            trayIcon.ContextMenuStrip = menu;
            trayIcon.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) TryWrapClipboardForDiscord();
            };

            // Field, not a local — SetWindowsHookEx only keeps a weak reference
            // to the delegate; if it were a local/lambda with nothing else
            // holding it, the GC could collect it and crash the process the
            // next time Windows calls into the (now-garbage) callback.
            keyboardProc = KeyboardHookCallback;
            using (Process curProcess = Process.GetCurrentProcess())
            using (ProcessModule curModule = curProcess.MainModule)
            {
                keyboardHookId = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, GetModuleHandle(curModule.ModuleName), 0);
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            AddClipboardFormatListener(Handle);
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            RemoveClipboardFormatListener(Handle);
            base.OnHandleDestroyed(e);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_CLIPBOARDUPDATE)
            {
                CheckClipboard();
            }
            base.WndProc(ref m);
        }

        private void CheckClipboard()
        {
            string text;
            try
            {
                if (!Clipboard.ContainsText()) return;
                text = Clipboard.GetText();
            }
            catch (ExternalException)
            {
                // Clipboard briefly locked by another app — just skip this tick.
                return;
            }

            if (text == null) return;
            text = text.Trim();
            if (text.Length == 0 || text == lastSeenText) return;
            lastSeenText = text;

            if (!text.StartsWith(PathPrefix, StringComparison.OrdinalIgnoreCase)) return;

            if (string.Equals(SourceProcessName(), "explorer", StringComparison.OrdinalIgnoreCase))
            {
                // Showing a ContextMenuStrip pumps its own nested message loop
                // while it's open — doing that synchronously, still inside
                // WndProc's handling of the WM_CLIPBOARDUPDATE message that
                // triggered it, is exactly the kind of reentrant call WinForms
                // handles unreliably (this is the leading suspect for a real
                // "stopped responding" hang seen in the field). BeginInvoke
                // defers it to a fresh top-level iteration of the message
                // loop instead.
                BeginInvoke(new Action(() => ShowChoicePopup(text)));
            }
            else
            {
                OpenInExplorer(text);
            }
        }

        // A tiny popup right at the cursor, offering an explicit choice
        // instead of guessing — dismissing it (click away, Escape, or just
        // ignore it) leaves the clipboard exactly as Explorer put it.
        private void ShowChoicePopup(string path)
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("📁 Ostavi kao putanju", null, (s, e) => { });
            menu.Items.Add("💬 Pripremi za Discord", null, (s, e) => WrapForDiscord(path));

            var autoClose = new System.Windows.Forms.Timer { Interval = 6000 };
            autoClose.Tick += (s, e) => { if (!menu.IsDisposed) menu.Close(); };
            // Cleanup happens exactly once here, regardless of whether the menu
            // closed because of a click or because the timer above fired.
            menu.Closed += (s, e) => { autoClose.Stop(); autoClose.Dispose(); };
            autoClose.Start();

            menu.Show(Cursor.Position);
        }

        // Fires on every keydown, system-wide — must return fast. Only acts
        // on Ctrl+V; everything else is passed straight through untouched.
        private IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN))
            {
                var hookStruct = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if (hookStruct.vkCode == VK_V && (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0)
                {
                    OnCtrlV();
                }
            }
            return CallNextHookEx(keyboardHookId, nCode, wParam, lParam);
        }

        // Never blocks or suppresses the keystroke — the original Ctrl+V is
        // always let through via CallNextHookEx above. This only swaps what's
        // sitting in the clipboard for the brief window before Discord's own
        // paste handler reads it, then puts the original back.
        private void OnCtrlV()
        {
            if (!IsForegroundDiscord()) return;

            string original;
            try
            {
                if (!Clipboard.ContainsText()) return;
                original = Clipboard.GetText();
            }
            catch (ExternalException) { return; }

            if (original == null) return;
            string trimmed = original.Trim();
            if (!trimmed.StartsWith(PathPrefix, StringComparison.OrdinalIgnoreCase)) return;

            string wrapped = "```\r\n" + trimmed + "\r\n```";
            try
            {
                Clipboard.SetText(wrapped);
            }
            catch (ExternalException) { return; }
            lastSeenText = wrapped; // don't let the passive watcher reprocess our own swap

            var restore = new System.Windows.Forms.Timer { Interval = 400 };
            restore.Tick += (s, e) =>
            {
                restore.Stop();
                restore.Dispose();
                try { Clipboard.SetText(original); } catch (ExternalException) { }
                lastSeenText = original;
            };
            restore.Start();
        }

        private static bool IsForegroundDiscord()
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero) return false;
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0) return false;
                using (var proc = Process.GetProcessById((int)pid))
                {
                    return proc.ProcessName.IndexOf("discord", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch
            {
                return false;
            }
        }

        // Whoever last called SetClipboardData still "owns" the clipboard until
        // someone else takes it — that owner window's process is what copied
        // this text in. Returns null if it can't be determined (no owner, or
        // the owning process has already exited).
        private static string SourceProcessName()
        {
            try
            {
                IntPtr owner = GetClipboardOwner();
                if (owner == IntPtr.Zero) return null;
                uint pid;
                GetWindowThreadProcessId(owner, out pid);
                if (pid == 0) return null;
                using (var proc = Process.GetProcessById((int)pid))
                {
                    return proc.ProcessName;
                }
            }
            catch
            {
                return null;
            }
        }

        private void OpenInExplorer(string path)
        {
            try
            {
                Process.Start("explorer.exe", "\"" + path + "\"");
            }
            catch
            {
                // Path might be unreachable right now (VPN off, share down) — nothing to recover here.
            }
        }

        // Fallback: click the tray icon to turn whatever datacenter path is
        // currently on the clipboard into a Discord-ready code block, for
        // when the popup was missed/dismissed. Only acts on a plain path
        // (not already wrapped), so clicking twice in a row is harmless.
        private void TryWrapClipboardForDiscord()
        {
            string text;
            try
            {
                if (!Clipboard.ContainsText()) return;
                text = Clipboard.GetText();
            }
            catch (ExternalException)
            {
                return;
            }
            if (text == null) return;
            text = text.Trim();
            if (!text.StartsWith(PathPrefix, StringComparison.OrdinalIgnoreCase)) return;
            WrapForDiscord(text);
        }

        private void WrapForDiscord(string path)
        {
            try
            {
                // Triple-backtick fence is what makes Discord render a code
                // block with its own one-click copy button on the receiving end.
                string wrapped = "```\r\n" + path + "\r\n```";
                Clipboard.SetText(wrapped);
                lastSeenText = wrapped; // don't re-process our own rewrite
                trayIcon.Text = WrappedTooltip;
                trayIcon.ShowBalloonTip(4000, "Darkroom", "Putanja je spremna za Discord — nalepi je (Ctrl+V).", ToolTipIcon.Info);
            }
            catch (ExternalException)
            {
                // Clipboard briefly locked by another app — nothing to recover here.
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (keyboardHookId != IntPtr.Zero)
                {
                    UnhookWindowsHookEx(keyboardHookId);
                    keyboardHookId = IntPtr.Zero;
                }
                trayIcon.Visible = false;
                trayIcon.Dispose();
                if (appIcon != SystemIcons.Application) appIcon.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.Run(new HiddenListenerForm());
        }
    }
}
