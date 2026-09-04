export const skillLevels = [
  { label: 'Mới chơi', score: 1 },
  { label: 'Yếu', score: 2 },
  { label: 'Trung bình yếu', score: 3 },
  { label: 'Trung bình', score: 4 },
  { label: 'Trung bình khá', score: 5 },
  { label: 'Khá', score: 6 },
  { label: 'Nghiệp dư', score: 7 },
  { label: 'Bán chuyên', score: 8 },
] as const;

export type SkillRange = { minScore: number; maxScore: number } | null;

const indexForScore = (score: number, boundary: 'min' | 'max'): number => {
  const exact = skillLevels.findIndex((level) => level.score === score);
  if (exact !== -1) return exact;
  if (boundary === 'min') {
    const next = skillLevels.findIndex((level) => level.score >= score);
    return next === -1 ? skillLevels.length - 1 : next;
  }
  for (let index = skillLevels.length - 1; index >= 0; index -= 1) if (skillLevels[index]!.score <= score) return index;
  return skillLevels.length - 1;
};

export const normalizeSkillRange = (range: SkillRange): SkillRange => {
  if (!range) return null;
  const minIndex = indexForScore(range.minScore, 'min');
  const maxIndex = indexForScore(range.maxScore, 'max');
  return { minScore: skillLevels[Math.min(minIndex, maxIndex)]!.score, maxScore: skillLevels[Math.max(minIndex, maxIndex)]!.score };
};

export const skillRangeLabel = (range: SkillRange): string => {
  const normalized = normalizeSkillRange(range);
  if (!normalized || (normalized.minScore === skillLevels[0].score && normalized.maxScore === skillLevels[skillLevels.length - 1].score)) return 'Mọi trình độ';
  const min = skillLevels[indexForScore(normalized.minScore, 'min')]!.label;
  const max = skillLevels[indexForScore(normalized.maxScore, 'max')]!.label;
  return min === max ? min : `${min} – ${max}`;
};

export const skillRangeIncludesIndex = (range: SkillRange, index: number): boolean => {
  const normalized = normalizeSkillRange(range);
  if (!normalized) return false;
  const score = skillLevels[index]!.score;
  return score >= normalized.minScore && score <= normalized.maxScore;
};

export const skillRangeFromIndex = (range: SkillRange, index: number): SkillRange => {
  const normalized = normalizeSkillRange(range);
  const score = skillLevels[index]!.score;
  if (!normalized) return { minScore: score, maxScore: score };
  if (score < normalized.minScore) return { minScore: score, maxScore: normalized.maxScore };
  if (score > normalized.maxScore) return { minScore: normalized.minScore, maxScore: score };
  if (normalized.minScore === normalized.maxScore) return null;
  if (score === normalized.minScore || score === normalized.maxScore) return { minScore: score, maxScore: score };
  return normalized;
};

export const skillRangesOverlap = (left: SkillRange, right: SkillRange): boolean => {
  const a = normalizeSkillRange(left); const b = normalizeSkillRange(right);
  return !a || !b || (a.minScore <= b.maxScore && b.minScore <= a.maxScore);
};
