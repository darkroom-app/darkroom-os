// DARKROOM OS: Datacenter Path Watcher — one-click installer.
//
// Embeds DatacenterPathWatcher.exe and darkroom32.ico as resources (see
// README's build command), so this is the single file that gets handed to
// each team member. Double-click it and it: copies both files into
// %LocalAppData%\DatacenterPathWatcher (no admin rights needed — this is
// the current user's own profile folder), drops a shortcut into the
// Startup folder via the standard WScript.Shell COM object (late-bound
// reflection, so no extra project references are needed to compile this
// with plain csc.exe), and launches the watcher immediately so it's
// running without waiting for the next login. Ends with a small message
// box confirming it worked, since otherwise a console-free installer that
// finishes instantly gives no feedback at all. Also doubles as the updater —
// re-running it stops any already-running watcher first (an in-use exe
// can't be overwritten on Windows), so shipping a new build is just "send
// this file again," same as the first install.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace DarkroomPathWatcher
{
    internal static class Setup
    {
        private const string ExeResourceName = "DatacenterPathWatcher.exe";
        private const string IconResourceName = "darkroom32.ico";

        [STAThread]
        private static void Main()
        {
            try
            {
                string installDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DatacenterPathWatcher");
                Directory.CreateDirectory(installDir);

                string exePath = Path.Combine(installDir, ExeResourceName);
                string iconPath = Path.Combine(installDir, IconResourceName);
                StopRunningWatcher();
                ExtractResource(ExeResourceName, exePath);
                ExtractResource(IconResourceName, iconPath);

                CreateStartupShortcut(exePath, installDir, iconPath);

                System.Diagnostics.Process.Start(exePath);

                MessageBox.Show(
                    "Instalacija završena. Darkroom Path Watcher je pokrenut i sad će se sam pokretati sa Windows-om.",
                    "Darkroom Path Watcher",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Instalacija nije uspela:\n" + ex.Message,
                    "Darkroom Path Watcher",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        // An already-running watcher.exe can't have its file overwritten (Windows
        // locks running executables) — stop any instance first so re-running this
        // installer works as an updater, not just a fresh install.
        private static void StopRunningWatcher()
        {
            string exeName = Path.GetFileNameWithoutExtension(ExeResourceName);
            foreach (Process p in Process.GetProcessesByName(exeName))
            {
                try { p.Kill(); p.WaitForExit(2000); }
                catch { /* best-effort — extraction below will surface any real problem */ }
            }
        }

        private static void ExtractResource(string resourceName, string destPath)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream src = asm.GetManifestResourceStream(resourceName))
            {
                if (src == null)
                    throw new InvalidOperationException("Ugrađeni resurs nije nađen: " + resourceName);
                using (FileStream dest = File.Create(destPath))
                {
                    src.CopyTo(dest);
                }
            }
        }

        // Creates a .lnk via the standard WScript.Shell COM object (present
        // on every Windows install) through late-bound reflection — avoids
        // needing a COM type-library reference just to compile this with
        // plain csc.exe.
        private static void CreateStartupShortcut(string exePath, string workingDir, string iconPath)
        {
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            string shortcutPath = Path.Combine(startupDir, "Darkroom Path Watcher.lnk");

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            try
            {
                object shortcut = shellType.InvokeMember("CreateShortcut",
                    BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type scType = shortcut.GetType();
                scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { exePath });
                scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
                scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { iconPath });
                scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                System.Runtime.InteropServices.Marshal.ReleaseComObject(shell);
            }
        }
    }
}
