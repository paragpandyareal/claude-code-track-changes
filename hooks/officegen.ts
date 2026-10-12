// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

import { crc32 } from './zip'

/**
 * Small, real Excel and Word files built in code, for /redline examples:
 * a zip of stored parts, a workbook from rows of cells, a document from
 * paragraphs and tables.
 */

function zipStored(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const header = (size: number) => {
    const b = new Uint8Array(size)
    return { b, v: new DataView(b.buffer) }
  }
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(text)
    const crc = crc32(data)
    const local = header(30 + nameBytes.length)
    local.v.setUint32(0, 0x04034b50, true)
    local.v.setUint16(4, 20, true)
    local.v.setUint32(14, crc, true)
    local.v.setUint32(18, data.length, true)
    local.v.setUint32(22, data.length, true)
    local.v.setUint16(26, nameBytes.length, true)
    local.b.set(nameBytes, 30)
    const entry = header(46 + nameBytes.length)
    entry.v.setUint32(0, 0x02014b50, true)
    entry.v.setUint16(4, 20, true)
    entry.v.setUint16(6, 20, true)
    entry.v.setUint32(16, crc, true)
    entry.v.setUint32(20, data.length, true)
    entry.v.setUint32(24, data.length, true)
    entry.v.setUint16(28, nameBytes.length, true)
    entry.v.setUint32(42, offset, true)
    entry.b.set(nameBytes, 46)
    chunks.push(local.b, data)
    central.push(entry.b)
    offset += local.b.length + data.length
  }
  const size = central.reduce((n, c) => n + c.length, 0)
  const end = header(22)
  end.v.setUint32(0, 0x06054b50, true)
  end.v.setUint16(8, central.length, true)
  end.v.setUint16(10, central.length, true)
  end.v.setUint32(12, size, true)
  end.v.setUint32(16, offset, true)
  const all = [...chunks, ...central, end.b]
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of all) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const letters = (n: number) => {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** A cell: text, a number (shown with thousands separators), or a formula with its saved result. */
export type GenCell = string | number | null | { f: string; v: number }

/** An .xlsx workbook: sheets of rows of cells, numbers shown as #,##0. */
export function makeXlsx(sheets: { name: string; rows: GenCell[][] }[]): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="3" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>',
  }
  const rels = sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`)
  rels.push('<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`
  files['xl/workbook.xml'] =
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, k) => `<sheet name="${esc(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('') +
    '</sheets></workbook>'
  sheets.forEach((sheet, k) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        const ref = `${letters(c + 1)}${r + 1}`
        if (cell === null) return ''
        if (typeof cell === 'number') return `<c r="${ref}" s="1"><v>${cell}</v></c>`
        if (typeof cell === 'string') return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="2"' : ''}><is><t xml:space="preserve">${esc(cell)}</t></is></c>`
        return `<c r="${ref}" s="1"><f>${esc(cell.f.replace(/^=/, ''))}</f><v>${cell.v}</v></c>`
      })
      return `<row r="${r + 1}">${cells.join('')}</row>`
    })
    files[`xl/worksheets/sheet${k + 1}.xml`] =
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`
  })
  return zipStored(files)
}

/** A block of a Word document: a paragraph with a style (Title, Heading1, Heading2, ListBullet), or a table. */
export type GenBlock = { p: string; style?: string } | { table: string[][] }

export function makeDocx(blocks: GenBlock[]): Uint8Array {
  const para = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
  const body = blocks
    .map(b => ('table' in b ? `<w:tbl>${b.table.map(row => `<w:tr>${row.map(cell => `<w:tc>${para(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : para(b.p, b.style)))
    .join('')
  const style = (id: string, name: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`
  return zipStored({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${style('Title', 'Title')}${style('Heading1', 'heading 1')}${style('Heading2', 'heading 2')}${style('ListBullet', 'List Bullet')}</w:styles>`,
  })
}
