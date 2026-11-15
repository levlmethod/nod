---
name: ga4-analysis
description: How to pull and read GA4 reports correctly: dimensions and metrics to use, date handling, sampling and thresholding traps, and how to split traffic, engagement and conversion questions.
---

# GA4 analysis

## Reports

- Always add the `date` dimension to a trend and sort by it yourself; GA4 rows don't come back in date order.
- Use `yesterday` as the end date for day-level comparisons. Today is partial, and GA4 can take up to 48 hours to settle.
- The property's time zone decides what a day is. Say which zone the report used.
- Core metrics: `sessions`, `totalUsers`, `engagedSessions`, `engagementRate`, `keyEvents` (GA4's conversions), `totalRevenue` and `purchaseRevenue`. Core dimensions: `date`, `sessionDefaultChannelGroup`, `sessionSourceMedium`, `landingPagePlusQueryString`, `deviceCategory`, `country`, `eventName`.
- Keep each request small: up to 9 dimensions and 10 metrics, and only what the question needs.

## Reading it

1. **Traffic question**: break sessions down by channel group and source/medium. A drop limited to one channel is that channel's problem, such as paid or organic.
2. **Engagement question**: break down by landing page and device. A sudden engagement drop on one page usually means the page broke.
3. **Conversion question**: break key events down by `eventName`, then by channel. If key events fell to zero while sessions held, suspect the tag before the funnel.
4. Compare with the ad platforms and Stripe for the same days. GA4 is the referee between platform claims, but it undercounts with consent banners and ad blockers, so compare trends, not absolute counts.

Low-volume segments can be withheld by GA4 thresholding. Say so rather than treating a missing row as zero.
