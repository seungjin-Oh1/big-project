const HWPX_TEMPLATE_ALIASES = {
  '답변서(가옥인도청구)': '답변서(건물인도청구에 대한 항변)',
};

export function resolveHwpxTemplateName(templateName) {
  return HWPX_TEMPLATE_ALIASES[templateName] || templateName;
}

export function isHwpxTemplateAlias(templateName) {
  return resolveHwpxTemplateName(templateName) !== templateName;
}
