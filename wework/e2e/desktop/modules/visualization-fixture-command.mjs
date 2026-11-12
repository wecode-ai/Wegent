const WRITE_FIXTURE_SCRIPT =
  "const fs=require('node:fs');const path=require('node:path');const data=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));fs.mkdirSync(path.dirname(data.file),{recursive:true});fs.writeFileSync(data.file,data.html,'utf8');console.log(data.marker)"

export function createVisualizationFixtureWriteCommand({ file, html, marker }) {
  const payload = Buffer.from(JSON.stringify({ file, html, marker }), 'utf8').toString('base64')
  return `node -e "${WRITE_FIXTURE_SCRIPT}" ${payload}`
}
