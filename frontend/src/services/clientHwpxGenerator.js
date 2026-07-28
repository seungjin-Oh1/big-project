import {
  HWPX_SKELETON_BASE64,
  HWPX_SECTION_PREAMBLE,
  HWPX_SECTION_FIRST_PARAGRAPH,
  HWPX_SECTION_ORIGINAL_TITLE,
  HWPX_SECTION_CLOSE,
} from './hwpxSkeletonData.js';

// ── 왜 "직접 XML을 새로 짜는 방식"에서 "실제 hwpx 파일을 골격으로 재사용하는 방식"으로 바꿨는가 ──
//
// 예전 구현은 mimetype/container.xml/header.xml/section0.xml을 전부 최소한의 XML로 손으로 지어
// zip으로 묶었습니다. zip 컨테이너 자체는 유효했지만, HWPX(OWPML) 스키마는 그보다 훨씬 엄격합니다:
// Contents/header.xml 하나에만 폰트·문단서식(paraPr)·글자서식(charPr)·스타일 정의가 수십~수백 개
// 필요하고, section0.xml의 모든 문단·런은 그 정의들을 id로 참조해야 합니다. 그 정의가 통째로
// 빠진 채(<hh:head/> 빈 태그) '한글' 프로그램에 열면 스키마 검증에서 걸려 예외 없이
// "파일이 손상되었습니다" 오류가 났습니다. 게다가 루트 요소 이름도 실제로는 <hs:sec>인데
// <hp:sec>로 잘못 짜여 있었습니다.
//
// 그래서 실제 '한글'이 만든 정상 hwpx 파일 하나(hwpxSkeletonData.js, 서식_hwpx 폴더의 실제 서식)를
// 통째로 base64로 담아두고, 그 zip 안에서 우리가 바꿔야 할 항목(Contents/section0.xml, 본문 내용)만
// 새로 만들어 바꿔치기합니다. 나머지 항목(header.xml/content.hpf/settings.xml/mimetype 등)은
// 원본 압축 바이트를 그대로 재사용하므로(압축을 풀었다 다시 압축하지 않고 바이트 그대로 복사)
// 항상 스키마상 유효합니다.

const HWPX_MIME_TYPE = 'application/hwp+zip';
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const SECTION0_ENTRY_NAME = 'Contents/section0.xml';

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

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// zip의 "중앙 디렉터리"를 읽어 각 항목(이름/압축방식/CRC/크기/원본 압축 바이트)을 그대로 꺼냅니다.
// 압축을 풀지 않습니다 — 우리가 손댈 section0.xml 말고는 바이트를 그대로 복사해 다시 쓸 것이므로
// deflate 해제/재압축 로직이 아예 필요 없습니다.
function parseZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');

  let eocdOffset = -1;
  const scanStart = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= scanStart; i -= 1) {
    if (view.getUint32(i, true) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('HWPX 골격 파일에서 zip 구조(EOCD)를 찾지 못했습니다.');
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  let ptr = centralDirOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(ptr, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('HWPX 골격 파일의 중앙 디렉터리 항목이 올바르지 않습니다.');
    }
    const versionMadeBy = view.getUint16(ptr + 4, true);
    const versionNeeded = view.getUint16(ptr + 6, true);
    const flag = view.getUint16(ptr + 8, true);
    const method = view.getUint16(ptr + 10, true);
    const modTime = view.getUint16(ptr + 12, true);
    const modDate = view.getUint16(ptr + 14, true);
    const crc = view.getUint32(ptr + 16, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const externalAttrs = view.getUint32(ptr + 38, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const nameStart = ptr + 46;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLen));
    ptr = nameStart + nameLen + extraLen + commentLen;

    // 실제 데이터 위치는 로컬 헤더(각 항목 앞에 한 번 더 있는 헤더) 안의 이름/추가필드 길이로
    // 계산합니다 — 중앙 디렉터리의 extraLen과 다를 수 있어 로컬 헤더 값을 따로 읽습니다.
    if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_FILE_SIGNATURE) {
      throw new Error(`HWPX 골격 파일의 로컬 헤더가 올바르지 않습니다: ${name}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + compressedSize);

    entries.push({
      name, versionMadeBy, versionNeeded, flag, method, modTime, modDate,
      crc, compressedSize, uncompressedSize, externalAttrs, data,
    });
  }
  return entries;
}

// entries를 그대로(순서·메타데이터 유지) 다시 zip으로 묶습니다. 압축 방식이 원본과 같은
// 항목(대부분 deflate)은 원본 압축 바이트를 그대로 복사하므로 항상 유효합니다.
function buildZipFromEntries(entries) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.name);
    // bit3(0x0008, 데이터 디스크립터 사용)은 우리가 항상 헤더에 정확한 crc/크기를 바로 쓰므로 끕니다.
    const flag = entry.flag & ~0x0008;

    const localHeader = new Uint8Array(30);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, ZIP_LOCAL_FILE_SIGNATURE, true);
    lv.setUint16(4, entry.versionNeeded, true);
    lv.setUint16(6, flag, true);
    lv.setUint16(8, entry.method, true);
    lv.setUint16(10, entry.modTime, true);
    lv.setUint16(12, entry.modDate, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, entry.compressedSize, true);
    lv.setUint32(22, entry.uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    const localEntry = concatBytes([localHeader, nameBytes, entry.data]);
    localChunks.push(localEntry);

    const centralHeader = new Uint8Array(46);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, ZIP_CENTRAL_DIRECTORY_SIGNATURE, true);
    cv.setUint16(4, entry.versionMadeBy, true);
    cv.setUint16(6, entry.versionNeeded, true);
    cv.setUint16(8, flag, true);
    cv.setUint16(10, entry.method, true);
    cv.setUint16(12, entry.modTime, true);
    cv.setUint16(14, entry.modDate, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.compressedSize, true);
    cv.setUint32(24, entry.uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, entry.externalAttrs, true);
    cv.setUint32(42, offset, true);
    centralChunks.push(concatBytes([centralHeader, nameBytes]));

    offset += localEntry.length;
  });

  const centralDir = concatBytes(centralChunks);
  const centralOffset = offset;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, ZIP_EOCD_SIGNATURE, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDir.length, true);
  ev.setUint32(16, centralOffset, true);

  return concatBytes([...localChunks, centralDir, eocd]);
}

let cachedSkeletonEntries = null;
function getSkeletonEntries() {
  if (!cachedSkeletonEntries) {
    cachedSkeletonEntries = parseZipEntries(base64ToBytes(HWPX_SKELETON_BASE64));
  }
  return cachedSkeletonEntries;
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 골격 문서의 "본문 텍스트 한 줄" 문단 패턴(paraPrIDRef="15"/charPrIDRef="7")을 그대로 재사용합니다.
// 이 패턴은 실제 문서에서 이미 쓰이고 있던 것이라 header.xml의 문단서식·글자서식 정의를
// 그대로 참조할 수 있어 별도 정의를 추가할 필요가 없습니다.
function buildBodyParagraphs(text) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.map((line, index) => {
    const vertpos = 1200 * (index + 1);
    const safeLine = escapeXml(line || ' ');
    return `<hp:p id="0" paraPrIDRef="15" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`
      + `<hp:run charPrIDRef="7"><hp:t>${safeLine}</hp:t></hp:run>`
      + `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${vertpos}" vertsize="1200" textheight="1200" `
      + `baseline="1020" spacing="960" horzpos="0" horzsize="45352" flags="393216"/></hp:linesegarray></hp:p>`;
  }).join('');
}

// 골격의 section0.xml 첫 문단(페이지/여백/머리말·꼬리말 등을 정의하는 hp:secPr가 들어있어
// 문서 전체에 반드시 있어야 함)은 그대로 재사용하고, 그 안의 원본 제목 텍스트만 우리 서식명으로
// 바꿔치기합니다. 그 뒤에는 원본 문서의 나머지 문단을 전부 버리고, 우리 초안 본문 줄마다
// 새 문단을 만들어 붙입니다.
function buildSectionXml(templateName, draftText) {
  const titleParagraph = HWPX_SECTION_FIRST_PARAGRAPH.replace(
    HWPX_SECTION_ORIGINAL_TITLE,
    escapeXml(templateName || '서식초안'),
  );
  return HWPX_SECTION_PREAMBLE + titleParagraph + buildBodyParagraphs(draftText) + HWPX_SECTION_CLOSE;
}

function safeFileName(name) {
  return String(name || '서식초안').replace(/[\\/:*?"<>|]/g, '_');
}

export function createClientHwpxDraft({ templateName, draftText }) {
  const entries = getSkeletonEntries();
  const sectionEntry = entries.find((entry) => entry.name === SECTION0_ENTRY_NAME);
  if (!sectionEntry) {
    throw new Error('HWPX 골격 파일에서 본문(section0.xml)을 찾지 못했습니다.');
  }

  const newSectionText = buildSectionXml(templateName, draftText);
  const newSectionBytes = new TextEncoder().encode(newSectionText);
  const newCrc = crc32(newSectionBytes);

  const rebuiltEntries = entries.map((entry) => (
    entry.name === SECTION0_ENTRY_NAME
      ? {
        ...entry,
        method: 0, // 압축 없이 그대로 저장 — deflate 구현 없이도 항상 유효하게 만들기 위함
        crc: newCrc,
        compressedSize: newSectionBytes.length,
        uncompressedSize: newSectionBytes.length,
        data: newSectionBytes,
      }
      : entry
  ));

  const zipBytes = buildZipFromEntries(rebuiltEntries);
  const fileName = `${safeFileName(templateName)}_초안.hwpx`;
  const blob = new Blob([zipBytes], { type: HWPX_MIME_TYPE });
  return { fileName, url: URL.createObjectURL(blob) };
}
