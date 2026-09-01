// DARKROOM OS: Datacenter path watcher (tray app)
//
// Watches the Windows clipboard for a path starting with \\DATACENTER\ and
// reacts based on WHERE it was copied from (Windows exposes the clipboard's
// current owner window, so the source app's process name is checkable):
//
//   - Copied from Explorer (explorer.exe)  -> sharing intent. Silently
//     rewrites the clipboard into a ```-fenced Discord code block, so a
//     plain Ctrl+V into a channel already renders with Discord's own
//     one-click copy button. No popup, no click, nothing to notice.
//   - Copied from anywhere else (Discord's code-block copy button, a
//     browser, ...) -> consuming intent. Immediately opens that path in
//     File Explorer. No confirmation, no menu.
//
// So the whole round trip is: copy in Explorer, paste in Discord (exactly
// normal Ctrl+C/Ctrl+V, nothing extra) -> whoever reads it clicks Discord's
// copy button once -> their Explorer opens. One click, on the receiving
// end, and it's Discord's own button, not a link we control.
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
// entirely — a background app reacting to what's already in the clipboard,
// keyed off which app put it there — sidesteps both.
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
                Text = "Darkroom — pratilac putanja",
                Visible = true
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add("Izađi", null, (s, e) => Application.Exit());
            trayIcon.ContextMenuStrip = menu;
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
                RewriteForDiscord(text);
            }
            else
            {
                OpenInExplorer(text);
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

        private void RewriteForDiscord(string path)
        {
            try
            {
                // Triple-backtick fence is what makes Discord render a code block
                // with its own one-click copy button on the receiving end.
                string wrapped = "```\r\n" + path + "\r\n```";
                Clipboard.SetText(wrapped);
                lastSeenText = wrapped; // don't re-process our own rewrite
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
