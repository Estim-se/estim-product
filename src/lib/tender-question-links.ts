// Links questions to the calculation posts they affect, by shared significant words (questions are written before the
// quantities exist). Used for presentation only; nothing in the calculation depends on it.
const STOP = new Set(['ska', 'skall', 'samt', 'eller', 'och', 'för', 'med', 'till', 'från', 'som', 'det', 'den', 'att', 'inte', 'vilka', 'vilken', 'gäller', 'underlaget', 'enligt', 'finns', 'antal', 'per', 'alla', 'samtliga', 'också', 'även', 'kan', 'vara', 'utförs', 'ingår', 'entreprenaden']);
const stem = (w: string) => w.replace(/(arna|erna|orna|ernas|arnas|en|et|na|ar|er|or|n)$/u, '');
const words = (s: string) => new Set(s.toLocaleLowerCase('sv').match(/[\p{L}]{4,}/gu)?.filter(w => !STOP.has(w)).map(stem).filter(w => w.length >= 4) ?? []);
export function questionPosts(question: string, posts: string[]): string[] {
  const q = words(question);
  return posts.filter(p => [...words(p)].some(w => q.has(w)));
}
