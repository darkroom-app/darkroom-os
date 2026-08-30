// DARKROOM OS: opener for the darkroom-open:// custom protocol.
//
// Compiled locally by install.bat, using the .NET Framework's built-in
// csc.exe (no download, no separate runtime, ships with every Windows
// 10/11 machine) - not shipped as a PowerShell script, because
// "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ..."
// is a well-known malware-loader signature that endpoint security tools
// (Bitdefender etc.) flag on sight, regardless of what the script itself
// actually does. A small native EXE that just calls
// Process.Start("explorer.exe", path) doesn't trip that heuristic at all.
//
// Windows passes the full clicked URI as args[0], e.g.:
//   darkroom-open:%5C%5CDATACENTER%5CProjekti%5CP0288%20-%2055%20Deans
// This strips the scheme, URL-decodes it back into a real Windows path,
// checks it's actually on the DATACENTER share (same allowlist as before -
// this never runs or executes anything from the target, Process.Start on
// explorer.exe just navigates a window, so the check is defense in depth,
// not a privilege boundary), and opens it in Explorer.

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

class DarkroomOpen {
    [STAThread]
    static void Main(string[] args) {
        try {
            if (args.Length == 0) {
                Warn("Nije prosledjena nijedna putanja.");
                return;
            }

            string uri = args[0];
            const string prefix = "darkroom-open:";
            if (uri.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) {
                uri = uri.Substring(prefix.Length);
            }
            uri = uri.TrimStart('/');
            string path = Uri.UnescapeDataString(uri).Replace('/', '\\');

            if (!path.StartsWith(@"\\DATACENTER\", StringComparison.OrdinalIgnoreCase)) {
                Warn("Ovaj link ne vodi na DATACENTER share pa je odbijen:\n\n" + path);
                return;
            }

            if (!Directory.Exists(path) && !File.Exists(path)) {
                Warn("Putanja ne postoji ili nije dostupna sa ovog racunara (proveri da li si na studio mrezi):\n\n" + path);
                return;
            }

            Process.Start("explorer.exe", "\"" + path + "\"");
        } catch (Exception ex) {
            Error("Nesto je poslo po zlu pri otvaranju foldera:\n\n" + ex.Message);
        }
    }

    static void Warn(string msg) {
        MessageBox.Show(msg, "Darkroom Open", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    static void Error(string msg) {
        MessageBox.Show(msg, "Darkroom Open", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
