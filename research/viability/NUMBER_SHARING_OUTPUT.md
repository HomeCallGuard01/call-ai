# Number-sharing / number-cost re-run

Full fully-loaded subscription model (`subscription-design.js`), 1,000 subscribers, Apple 15%. Each cell shows normal / heavy / stress margin. ✔ = normal ≥ 40% **and** heavy, stress ≥ 0%.
The number cost includes the 5% quarantine overhead. The shared rows add a £300/month SIP edge proxy (ASSUMPTION).

## SDK leg at list (conservative)

| Number architecture | Number £/hh | £5.99 | £6.99 | £7.99 | £9.99 | Lowest compliant price |
|---|---|---|---|---|---|---|
| 1 number/household, retail £2.00 (PUBLISHED) | £2.10 | -17% / -36% / -59% | -2% / -19% / -39% | 9% / -6% / -23% | 24% / 12% / -1% | none ≤ £9.99 |
| 1 number/household, wholesale £1.00 (QUOTE) | £1.05 | 4% / -15% / -38% | 16% / -1% / -21% | 25% / 10% / -7% | 37% / 25% / 11% | none ≤ £9.99 |
| 1 number/household, wholesale £0.50 (QUOTE) | £0.53 | 15% / -5% / -28% | 25% / 8% / -12% | 32% / 18% / 1% | 43% / 31% / 18% ✔ | £9.99 |
| 1 number/household, own Ofcom range ~£0.10 incl. hosting (QUOTE; Ofcom charge ≤ 10p/number/YEAR) | £0.11 | 23% / 4% / -19% | 32% / 15% / -4% | 39% / 24% / 7% | 48% / 36% / 23% ✔ | £9.99 |
| Shared 1:2 at £2.00 retail + SIP edge proxy | £1.05 | -2% / -21% / -44% | 11% / -6% / -26% | 20% / 6% / -12% | 33% / 22% / 8% | none ≤ £9.99 |
| Shared 1:3 at £2.00 retail + proxy | £0.70 | 5% / -14% / -37% | 17% / 0% / -20% | 25% / 11% / -7% | 37% / 26% / 12% | none ≤ £9.99 |
| Shared 1:10 at £2.00 retail + proxy | £0.21 | 15% / -4% / -27% | 25% / 9% / -11% | 33% / 18% / 1% | 43% / 32% / 18% ✔ | £9.99 |
| Shared ~negligible (1:100+) + proxy | £0.02 | 19% / -1% / -24% | 28% / 12% / -8% | 35% / 21% / 4% | 45% / 34% / 20% ✔ | £9.99 |

## SDK leg £0 (as invoiced today)

| Number architecture | Number £/hh | £5.99 | £6.99 | £7.99 | £9.99 | Lowest compliant price |
|---|---|---|---|---|---|---|
| 1 number/household, retail £2.00 (PUBLISHED) | £2.10 | 1% / -11% / -25% | 13% / 3% / -9% | 22% / 13% / 3% | 35% / 28% / 19% | none ≤ £9.99 |
| 1 number/household, wholesale £1.00 (QUOTE) | £1.05 | 22% / 10% / -4% | 31% / 21% / 9% | 38% / 29% / 19% | 47% / 40% / 32% ✔ | £9.99 |
| 1 number/household, wholesale £0.50 (QUOTE) | £0.53 | 32% / 21% / 7% | 40% / 30% / 18% ✔ | 46% / 37% / 26% ✔ | 54% / 47% / 38% ✔ | £6.99 |
| 1 number/household, own Ofcom range ~£0.10 incl. hosting (QUOTE; Ofcom charge ≤ 10p/number/YEAR) | £0.11 | 41% / 29% / 15% ✔ | 47% / 37% / 25% ✔ | 52% / 43% / 33% ✔ | 59% / 52% / 43% ✔ | £5.99 |
| Shared 1:2 at £2.00 retail + SIP edge proxy | £1.05 | 16% / 4% / -10% | 26% / 16% / 4% | 33% / 25% / 14% | 44% / 37% / 28% ✔ | £9.99 |
| Shared 1:3 at £2.00 retail + proxy | £0.70 | 23% / 11% / -3% | 32% / 22% / 10% | 39% / 30% / 19% | 48% / 41% / 33% ✔ | £9.99 |
| Shared 1:10 at £2.00 retail + proxy | £0.21 | 33% / 21% / 7% | 40% / 30% / 18% ✔ | 46% / 37% / 27% ✔ | 54% / 47% / 38% ✔ | £6.99 |
| Shared ~negligible (1:100+) + proxy | £0.02 | 37% / 25% / 11% | 44% / 34% / 22% ✔ | 49% / 40% / 29% ✔ | 56% / 49% / 41% ✔ | £6.99 |

## Per-price detail: own-range or near-zero numbers (£0.10/hh), SDK £0 vs list

### SDK leg at list (conservative)

| Price | Contribution £/sub | Normal | Heavy | Stress | Break-even avg min | Below 40% when avg min > |
|---|---|---|---|---|---|---|
| £5.99 | £1.16 | 23% | 4% | -19% | 371 | 145 |
| £6.99 | £1.87 | 32% | 15% | -4% | 451 | 188 |
| £7.99 | £2.58 | 39% | 24% | 7% | 532 | 231 |
| £9.99 | £4.00 | 48% | 36% | 23% | 693 | 316 |

### SDK leg £0 (as invoiced today)

| Price | Contribution £/sub | Normal | Heavy | Stress | Break-even avg min | Below 40% when avg min > |
|---|---|---|---|---|---|---|
| £5.99 | £2.04 | 41% | 29% | 15% | 636 | 249 |
| £6.99 | £2.75 | 47% | 37% | 25% | 774 | 322 |
| £7.99 | £3.46 | 52% | 43% | 33% | 912 | 395 |
| £9.99 | £4.89 | 59% | 52% | 43% | 1188 | 542 |

Normal mix: 240 avg forwarded min/sub/month (ASSUMPTION).

