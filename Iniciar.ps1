$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if(Test-Path -LiteralPath '.local/credentials.xml'){
 $credentials=Import-Clixml -LiteralPath '.local/credentials.xml'
 $env:CLOUD_CLIENT_TOKEN=[Net.NetworkCredential]::new('',$credentials['CLIENT_TOKEN']).Password
 $env:CLOUD_URL=$credentials['CLOUD_URL']
}
if(-not(Test-Path -LiteralPath 'node_modules')){npm ci --ignore-scripts --no-audit --no-fund}
Write-Host 'Interfaz local: http://127.0.0.1:4180'
node src/server.js
