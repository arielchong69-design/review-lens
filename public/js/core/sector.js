// 第二比较基准：同花顺行业 / 概念指数。
// 原则：
//  1. 类型只根据扶摇“同花顺指数目录”（tag=industry / cn_concept）判定，概念指数永远不会被标成“所属行业”。
//  2. 与股票的关系只根据“指数当前成分股”判定；扶摇只提供当前成分，历史成分无法核实，页面必须写明。
//  3. 无法确认关系时，一律视为“用户指定的比较基准”，不认定为该股票所属行业。

export const SECTOR_CODE_RE = /^\d{6}\.TI$/;

export const SECTOR_TYPE_LABEL = { industry: '行业指数', concept: '概念指数', unknown: '类型未核实' };
export const SECTOR_ROLE_LABEL = {
  industry_member: '所属行业指数（按当前成分判断）',
  concept_member: '相关概念指数（该股为当前成分股）',
  user_specified: '用户指定的比较基准',
};
export const HISTORY_CAVEAT = '成分关系按当前成分股判断，历史成分无法核实：交易发生时该股是否已属于此指数未经确认';

/** 代码格式检查（不发请求） */
export function checkSectorCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { code: '', ok: true, empty: true };
  if (!SECTOR_CODE_RE.test(c)) return { code: c, ok: false, error: `比较指数“${code}”格式不对，需为同花顺行业或概念指数代码，如 886042.TI` };
  return { code: c, ok: true };
}

/**
 * 根据目录与成分股结果解析比较基准。
 * @param code 已规范化的指数代码
 * @param stockCode 股票代码
 * @param catalogs { industry: {ok, items:[{thscode,name}]}, cn_concept: {ok, items} }
 * @param constituents { ok, items:[{thscode}] } 或 null
 */
export function resolveSector(code, stockCode, catalogs, constituents) {
  const notes = [];
  const find = tag => (catalogs?.[tag]?.ok ? (catalogs[tag].items || []).find(x => String(x.thscode).toUpperCase() === code) : null);
  const ind = find('industry'), con = find('cn_concept');
  const catalogsOk = !!(catalogs?.industry?.ok && catalogs?.cn_concept?.ok);
  let type = 'unknown', name = code, valid = true, verified = true;
  if (ind) { type = 'industry'; name = ind.name; }
  else if (con) { type = 'concept'; name = con.name; }
  else if (catalogsOk) {
    return { thscode: code, valid: false, verified: false, type: 'unknown', name: code, relation: 'unknown', role: null,
      error: `在同花顺行业和概念指数目录中都找不到 ${code}，可能代码有误或不是行业/概念指数，已不使用该比较基准`, notes };
  } else {
    verified = false;
    notes.push('指数目录获取失败，无法核实该代码的名称和类型');
  }
  let relation = 'unknown';
  if (constituents?.ok) {
    relation = (constituents.items || []).some(x => String(x.thscode).toUpperCase() === stockCode) ? 'member' : 'not_member';
  } else notes.push('成分股获取失败，无法确认该股票是否属于此指数');
  const role = relation === 'member' && type === 'industry' ? 'industry_member' : relation === 'member' && type === 'concept' ? 'concept_member' : 'user_specified';
  if (relation === 'member') notes.push(HISTORY_CAVEAT);
  if (relation === 'not_member') notes.push(`${stockCode} 不在该指数当前成分股中，只作为用户指定的比较基准，不认定为所属行业`);
  if (relation === 'unknown') notes.push('未能确认成分关系，只作为用户指定的比较基准，不认定为所属行业');
  return { thscode: code, valid, verified, type, typeLabel: SECTOR_TYPE_LABEL[type], name, relation, role, roleLabel: SECTOR_ROLE_LABEL[role], notes };
}

/** 页面与证据中使用的一行说明 */
export function sectorDisplay(s) {
  if (!s || !s.valid) return null;
  return `${s.name}（${s.thscode}，${s.typeLabel} · ${s.roleLabel}）`;
}

/** 从一组交易中为每只股票确定比较指数；同一股票填了不同代码时取第一个并提示 */
export function sectorCodesByStock(trades) {
  const map = {}, warnings = [];
  for (const t of trades) {
    const c = String(t.sector_code || '').trim().toUpperCase();
    if (!c) continue;
    if (!map[t.thscode]) map[t.thscode] = c;
    else if (map[t.thscode] !== c) warnings.push(`${t.thscode} 填写了多个比较指数（${map[t.thscode]}、${c}），使用第一个`);
  }
  return { map, warnings };
}
