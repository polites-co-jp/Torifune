# Application Layer

UseCase の実装、トランザクション境界、**認可の強制点**。

Permission チェックはここで行う。Server Component からの直接呼び出しでも REST 経由でも
同じ判定が働くようにするため（`docs/実装計画/001-Torifune単体稼働/00_決定事項.md` D-06）。

> 詳細は `docs/仕様書/07_開発者向けガイド.md` §8 を参照。
