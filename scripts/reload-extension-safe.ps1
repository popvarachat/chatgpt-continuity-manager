param(
  [string]$ExtensionId = 'jjdiaeffobjoiolpjjmgbbcbmiiahafl',
  [int]$TimeoutSeconds = 10,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome executable was not found.' }

$beforeHandles = @(
  Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object { [int64]$_.MainWindowHandle }
)

$targetUrl = "chrome://extensions/?id=$ExtensionId"
Start-Process -FilePath $chrome -ArgumentList @('--new-window', 'about:blank') | Out-Null
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$helperProcess = $null
while ((Get-Date) -lt $deadline -and -not $helperProcess) {
  Start-Sleep -Milliseconds 200
  $helperProcess = Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      ([int64]$_.MainWindowHandle -notin $beforeHandles)
    } |
    Select-Object -First 1
}

if (-not $helperProcess) {
  throw 'Safe reload aborted: Chrome did not create a dedicated helper window.'
}

$helperHandle = [IntPtr]$helperProcess.MainWindowHandle
$root = [System.Windows.Automation.AutomationElement]::FromHandle($helperHandle)
$addressCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Address and search bar'
  ))
)
$address = $root.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  $addressCondition
)
if (-not $address) {
  throw 'Safe reload aborted: Address bar was not found in the dedicated helper window.'
}
$valuePattern = $address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$valuePattern.SetValue($targetUrl)
$address.SetFocus()
$wsh = New-Object -ComObject WScript.Shell
[void]$wsh.AppActivate($helperProcess.Id)
Start-Sleep -Milliseconds 150
$wsh.SendKeys('{ENTER}')
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$documentCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Document
)
$reloadIdCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    'dev-reload-button'
  ))
)
$reloadNameCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Reload'
  ))
)
$reload = $null
while ((Get-Date) -lt $deadline -and -not $reload) {
  $reload = $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    $reloadIdCondition
  )
  if (-not $reload) {
    $documents = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $documentCondition
    )
    for ($i = 0; $i -lt $documents.Count -and -not $reload; $i++) {
      $candidate = $documents.Item($i)
      if ($candidate.Current.Name -like 'Extensions*') {
        $reload = $candidate.FindFirst(
          [System.Windows.Automation.TreeScope]::Descendants,
          $reloadNameCondition
        )
      }
    }
  }
  if (-not $reload) { Start-Sleep -Milliseconds 200 }
}

try {
  if (-not $reload) {
    throw 'Safe reload aborted: Extension dev-reload-button was not found in the helper Extensions document.'
  }

  if ($DryRun) {
    Write-Output "SAFE_RELOAD_DRY_RUN_OK extension=$ExtensionId helper_handle=$helperHandle"
  }
  else {
    $reload.GetCurrentPattern(
      [System.Windows.Automation.InvokePattern]::Pattern
    ).Invoke()
    Start-Sleep -Milliseconds 800
    Write-Output "SAFE_RELOAD_OK extension=$ExtensionId"
  }
}
finally {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UaiosNativeWindow {
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
  [void][UaiosNativeWindow]::PostMessage($helperHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
