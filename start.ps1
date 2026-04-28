$bundledNode = "C:\Users\bigcu\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$nodePath = if (Test-Path $bundledNode) { $bundledNode } else { "node" }

Set-Location $PSScriptRoot
& $nodePath ".\server.js"
