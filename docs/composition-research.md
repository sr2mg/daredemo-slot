# 作曲エンジンの仮説・検証ログ

作曲エンジンへ新しい理論やルールを追加する前に、次の正本を読むこと。

- [`src/core/music/composition-research.ts`](../src/core/music/composition-research.ts)

このファイルには、比較実験の履歴、暫定結果、未検証の仮説、次に行うA/B比較が構造化データとして保存されている。Web UIの「作曲仮説と検証履歴」も同じデータを直接表示する。

## 更新手順

1. 実装前に `COMPOSITION_HYPOTHESES` へ反証可能な仮説と比較方法を追加する。
2. 比較を実装したら、対応する仮説を `partiallyTested` または `tested` にする。
3. 結果を `COMPOSITION_EXPERIMENTS` へ追加し、仮説の `experimentIds` から参照する。
4. 少数試行や複合条件など、結果からまだ言えないことを `limitations` に残す。
5. 一曲固有の模倣ではなく、複数曲へ一般化できる仮説を優先する。

過去の結果を書き換えて消さず、新しい実験として追記する。結論が変わった場合も、どの実験によって更新されたかを参照で辿れる状態に保つ。
