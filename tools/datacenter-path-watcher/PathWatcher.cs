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
//
// So: copy a path in Explorer, a small choice appears — pick a lane, or
// ignore it and keep working (Photoshop/Max/anywhere paste unaffected).
// Receiving end: click Discord's copy button once, Explorer opens.
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

        private const int WM_CLIPBOARDUPDATE = 0x031D;
        private const string PathPrefix = @"\\DATACENTER\";
        private const string IdleTooltip = "Darkroom — pratilac putanja";
        private const string WrappedTooltip = "Spremno za Discord — nalepi (Ctrl+V)";

        private readonly NotifyIcon trayIcon;
        private readonly Icon appIcon;
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
                ShowChoicePopup(text);
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
