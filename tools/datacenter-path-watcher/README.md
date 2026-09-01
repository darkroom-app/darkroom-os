# Datacenter Path Watcher

Small Windows tray app: watches the clipboard, and when you copy a path
starting with `\\DATACENTER\` (e.g. via the one-click copy button on a
Discord code block), it lets you open that path in File Explorer with one
click on the tray icon.

Built this way (rather than a clickable Discord link) because a browser
always shows a confirmation dialog before handing off to any non-http(s)
protocol, and antivirus/EDR software flags exactly that "browser triggers
local execution" pattern — including Windows' own `search-ms:` protocol,
which is now a known phishing vector too. A background app reacting to the
clipboard sidesteps both: no browser involved, no custom protocol, no
PowerShell, no admin rights, just `AddClipboardFormatListener` (a standard
Win32 API) and `Process.Start("explorer.exe", path)`.

## Using it

1. Copy a `\\DATACENTER\...` path (e.g. the copy button on a Discord code
   block, or select + Ctrl+C from anywhere).
2. A balloon notification may appear — click it, **or** just left-click the
   Darkroom tray icon. Either opens that path in Explorer.

The balloon isn't fully reliable across Windows versions/notification
settings, so the tray-icon click is the guaranteed path — that's why it's
there as a fallback rather than the only trigger.

## Installing (per machine, one-time)

1. Copy `DatacenterPathWatcher.exe` and `darkroom32.ico` together into a
   permanent folder (e.g. `C:\Tools\DatacenterPathWatcher\`) — the exe
   loads the icon from its own folder at startup, so they must stay
   together.
2. Right-click `DatacenterPathWatcher.exe` → **Create shortcut**.
3. Press **Win+R**, type `shell:startup`, Enter — this opens your Startup
   folder.
4. Move the shortcut into that folder.

That's it — no registry edits, no scripts. It'll launch quietly (just the
tray icon, no window) every time you log in. To stop it permanently, delete
the shortcut from the Startup folder; to stop it for the current session,
right-click the tray icon → **Izađi**.

## Rebuilding from source

No build system needed — compiles with the C# compiler already bundled in
every Windows install (`csc.exe`, part of .NET Framework):

```
"C:\WINDOWS\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /platform:anycpu /win32icon:darkroom.ico /out:DatacenterPathWatcher.exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll PathWatcher.cs
```

`darkroom.ico` (256px, used as the .exe's own file icon) and
`darkroom32.ico` (32px, loaded at runtime for the tray icon) are both
generated from `favicon-source.png.png` at the repo root.
