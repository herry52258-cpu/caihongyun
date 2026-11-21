// 购买页套餐。顺序跟接口数组走，周期顺序跟后台 OrderSave 字段走。
// 购买弹窗本身是固定深色，说明文字继承弹窗颜色，窄屏自动换行。

export const DEDICATED_LINE_NOTE =
  '强烈推荐少人共享专线。常刷 TikTok、看 YouTube 或在线 4K 视频，优先考虑专线，减少多人争抢带宽。实际流畅度仍受本地网络和时段影响。'

export const PERIODS: [string, string][] = [
  ['month_price', '/月'],
  ['quarter_price', '/季'],
  ['half_year_price', '/半年'],
  ['year_price', '/年'],
  ['two_year_price', '/2年'],
  ['three_year_price', '/3年'],
  ['onetime_price', '/永久'],
]

export type PlanItem = {
  id: number
  name: string
  price: number
  period: string
  label: string
  orig: number | null
}

export const buildPlans = (data: unknown[]): PlanItem[] => {
  const out: PlanItem[] = []
  for (const raw of data || []) {
    const pl = raw as Record<string, unknown>
    for (const [key, label] of PERIODS) {
      const price = pl[key]
      if (price != null && Number(price) > 0) {
        const cents = Number(price)
        out.push({
          id: Number(pl.id),
          name: String(pl.name ?? '套餐'),
          price: cents,
          period: key,
          label,
          orig: key === 'onetime_price' && cents === 99900 ? 199900 : null,
        })
      }
    }
  }
  return out
}

export const pickDefaultPlan = (list: readonly PlanItem[]): PlanItem | null =>
  list.find((plan) => plan.period === 'year_price') ||
  list.find((plan) => plan.period === 'onetime_price') ||
  list[0] ||
  null
