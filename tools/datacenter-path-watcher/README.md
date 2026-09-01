# Datacenter Path Watcher

Small Windows tray app: watches the clipboard for a path starting with
`\\DATACENTER\` and reacts based on which app copied it — Windows exposes
the clipboard's current owner window, so the source process is checkable:

- **Copied from Explorer** → sharing intent. Silently rewrites the
  clipboard into a `` ``` ``-fenced Discord code block, so a plain Ctrl+V
  into a channel already renders with Discord's own one-click copy button.
  No popup, no click needed — you don't do anything differently.
- **Copied from anywhere else** (Discord's code-block copy button, a
  browser, ...) → consuming intent. Immediately opens that path in File
  Explorer. No confirmation, no menu.

So the whole round trip is: copy in Explorer, paste in Discord — exactly
normal Ctrl+C/Ctrl+V, nothing extra — and whoever reads it clicks Discord's
own copy button once and their Explorer opens. One click, on the receiving
end, using Discord's button rather than a link we control.

Built this way (rather than a clickable Discord link) because a browser
always shows a confirmation dialog before handing off to any non-http(s)
protocol, and antivirus/EDR software flags exactly that "browser triggers
local execution" pattern — including Windows' own `search-ms:` protocol,
which is now a known phishing vector too. A background app reacting to the
clipboard, keyed off which app put the text there, sidesteps both: no
browser involved, no custom protocol, no PowerShell, no admin rights, just
`AddClipboardFormatListener`/`GetClipboardOwner` (standard Win32 APIs) and
`Process.Start("explorer.exe", path)`.

## Using it

Nothing to remember — just copy and paste as usual. Copying a
`\\DATACENTER\...` path anywhere that *isn't* Explorer (most commonly:
clicking the copy button on a Discord code block) opens it in Explorer
immediately.

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
