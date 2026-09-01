// DARKROOM OS: Datacenter path watcher (tray app)
//
// Watches the Windows clipboard. When you copy a path that starts with
// \\DATACENTER\ (e.g. from a Discord message's code block, using its
// built-in one-click copy button), it shows a balloon notification —
// click the balloon to open that path in File Explorer.
//
// Deliberately simple and boring: no browser, no custom URL protocol, no
// PowerShell, no admin rights, no network calls. Just a clipboard listener
// (AddClipboardFormatListener, a standard Win32 API) and Process.Start on
// explorer.exe — the same thing double-clicking a folder shortcut does.
// This exists because the earlier attempt at "clickable Discord link opens
// Explorer" hit two walls that no implementation trick gets around: browsers
// always show a confirmation dialog before handing off to any non-http(s)
// protocol, and antivirus/EDR software flags exactly that browser-triggers-
// local-execution pattern (even Windows' own search-ms: protocol, once a
// documented phishing vector, now gets flagged too). Moving the trigger
// out of the browser entirely — a background app reacting to what's
// already sitting in the clipboard — sidesteps both.
//
// Autostart: NOT registered automatically by this program. Copy the built
// .exe somewhere permanent, then drop a shortcut to it into your Startup
// folder (Win+R -> shell:startup) so it launches quietly every login. No
// registry edits, no scripts — a plain shortcut, removable by deleting it.

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

        private const int WM_CLIPBOARDUPDATE = 0x031D;
        private const string PathPrefix = @"\\DATACENTER\";

        private readonly NotifyIcon trayIcon;
        private readonly Icon appIcon;
        private const string IdleTooltip = "Darkroom — pratilac putanja";
        private string pendingPath;
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

            // The balloon tip is a nice-to-have — Windows 10/11 sometimes suppresses
            // it entirely depending on notification settings, so it's not the only
            // way in. A left-click on the tray icon always works too, regardless of
            // whether the balloon ever showed.
            trayIcon.BalloonTipClicked += (s, e) => OpenPendingPath();
            trayIcon.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) OpenPendingPath();
            };
        }

        private void OpenPendingPath()
        {
            if (pendingPath == null) return;
            try
            {
                Process.Start("explorer.exe", "\"" + pendingPath + "\"");
            }
            catch
            {
                // Path might be unreachable right now (VPN off, share down) — nothing to recover here.
            }
            pendingPath = null;
            trayIcon.Text = IdleTooltip;
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

            if (text.StartsWith(PathPrefix, StringComparison.OrdinalIgnoreCase))
            {
                pendingPath = text;
                // NotifyIcon.Text has a hard 63-character limit (throws past that on
                // older .NET Framework) — truncate defensively, the full path still
                // shows in the balloon body when that gets through.
                string tooltip = "Klikni da otvoriš: " + text;
                trayIcon.Text = tooltip.Length > 63 ? tooltip.Substring(0, 60) + "..." : tooltip;
                trayIcon.ShowBalloonTip(8000, "Datacenter putanja", "Klikni da otvoriš u Exploreru:\n" + text, ToolTipIcon.Info);
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
