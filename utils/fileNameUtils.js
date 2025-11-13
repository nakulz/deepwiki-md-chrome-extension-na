export const FALLBACK_FILENAME = 'deepwiki-page';

export function sanitizeFilename(input, options = {}) {
  const { allowEmpty = false } = options;

  if (!input || typeof input !== 'string') {
    return allowEmpty ? '' : FALLBACK_FILENAME;
  }

  let sanitized = input
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '-');

  sanitized = sanitized
    .replace(/[\u0000-\u001F<>:"/\\|?*\u007F]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.');

  sanitized = sanitized.replace(/^[.-]+/, '').replace(/[.-]+$/, '');

  if (!sanitized) {
    return allowEmpty ? '' : FALLBACK_FILENAME;
  }

  return sanitized;
}

export function ensureMarkdownExtension(fileName) {
  if (!fileName) {
    return 'resource.md';
  }

  return fileName.toLowerCase().endsWith('.md') ? fileName : `${fileName}.md`;
}

export function ensureUniqueName(baseName, usedNames) {
  if (!(usedNames instanceof Set)) {
    return baseName;
  }

  const normalizedBase = baseName.toLowerCase();
  if (!usedNames.has(normalizedBase)) {
    usedNames.add(normalizedBase);
    return baseName;
  }

  const baseWithoutExtension = baseName.replace(/\.md$/i, '');
  let index = 2;
  let candidate = ensureMarkdownExtension(`${baseWithoutExtension}-${index}`);

  while (usedNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = ensureMarkdownExtension(`${baseWithoutExtension}-${index}`);
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export function ensureUniqueFileTitle(baseTitle, index, usedTitles) {
  const fallback = `page-${index}`;
  let candidate = sanitizeFilename(baseTitle || fallback, { allowEmpty: true });

  if (!candidate) {
    candidate = fallback;
  }

  if (!(usedTitles instanceof Set)) {
    return candidate;
  }

  if (!usedTitles.has(candidate)) {
    usedTitles.add(candidate);
    return candidate;
  }

  let suffix = 2;
  let uniqueCandidate = `${candidate}-${suffix}`;
  while (usedTitles.has(uniqueCandidate)) {
    suffix += 1;
    uniqueCandidate = `${candidate}-${suffix}`;
  }

  usedTitles.add(uniqueCandidate);
  return uniqueCandidate;
}
