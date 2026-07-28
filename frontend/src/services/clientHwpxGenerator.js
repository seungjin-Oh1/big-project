const HWPX_MIME_TYPE = 'application/hwp+zip';
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function encodeText(value) {
  return new TextEncoder().encode(value);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear()) - 1980;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    date: (year << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function concatBytes(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

function localHeader({ nameBytes, dataBytes, checksum, modified }) {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, ZIP_LOCAL_FILE_HEADER);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 0x0800);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, modified.time);
  writeUint16(view, 12, modified.date);
  writeUint32(view, 14, checksum);
  writeUint32(view, 18, dataBytes.length);
  writeUint32(view, 22, dataBytes.length);
  writeUint16(view, 26, nameBytes.length);
  writeUint16(view, 28, 0);
  return header;
}

function centralHeader({ nameBytes, dataBytes, checksum, modified, offset }) {
  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, ZIP_CENTRAL_DIRECTORY_HEADER);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 20);
  writeUint16(view, 8, 0x0800);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, modified.time);
  writeUint16(view, 14, modified.date);
  writeUint32(view, 16, checksum);
  writeUint32(view, 20, dataBytes.length);
  writeUint32(view, 24, dataBytes.length);
  writeUint16(view, 28, nameBytes.length);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, offset);
  return header;
}

function endOfCentralDirectory({ fileCount, centralSize, centralOffset }) {
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, ZIP_END_OF_CENTRAL_DIRECTORY);
  writeUint16(view, 8, fileCount);
  writeUint16(view, 10, fileCount);
  writeUint32(view, 12, centralSize);
  writeUint32(view, 16, centralOffset);
  writeUint16(view, 20, 0);
  return header;
}

function zipStored(files) {
  const modified = dosDateTime();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encodeText(file.name);
    const dataBytes = encodeText(file.content);
    const checksum = crc32(dataBytes);
    const local = concatBytes([localHeader({ nameBytes, dataBytes, checksum, modified }), nameBytes, dataBytes]);
    localChunks.push(local);
    centralChunks.push(concatBytes([centralHeader({ nameBytes, dataBytes, checksum, modified, offset }), nameBytes]));
    offset += local.length;
  });

  const central = concatBytes(centralChunks);
  return concatBytes([...localChunks, central, endOfCentralDirectory({
    fileCount: files.length,
    centralSize: central.length,
    centralOffset: offset,
  })]);
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sectionXml(text) {
  const paragraphs = String(text || '')
    .split(/\r?\n/)
    .map((line) => `<hp:p><hp:run><hp:t>${escapeXml(line || ' ')}</hp:t></hp:run></hp:p>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${paragraphs}</hp:sec>`;
}

function safeFileName(name) {
  return String(name || '서식초안').replace(/[\\/:*?"<>|]/g, '_');
}

export function createClientHwpxDraft({ templateName, draftText }) {
  const fileName = `${safeFileName(templateName)}_초안.hwpx`;
  const files = [
    { name: 'mimetype', content: HWPX_MIME_TYPE },
    { name: 'META-INF/container.xml', content: '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles></container>' },
    { name: 'version.xml', content: '<?xml version="1.0" encoding="UTF-8"?><version app="frontend" hwpx-version="1.0"/>' },
    { name: 'Contents/content.hpf', content: '<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.hancom.co.kr/hwpml/2011/package"><opf:manifest><opf:item id="header" href="header.xml" media-type="application/xml"/><opf:item id="section0" href="section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>' },
    { name: 'Contents/header.xml', content: '<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"/>' },
    { name: 'Contents/section0.xml', content: sectionXml(draftText) },
  ];
  const blob = new Blob([zipStored(files)], { type: HWPX_MIME_TYPE });
  return { fileName, url: URL.createObjectURL(blob) };
}
