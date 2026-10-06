On Error Resume Next
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\antho\Documents\ai\Haven\scripts\ensure-haven.ps1""", 0, False
