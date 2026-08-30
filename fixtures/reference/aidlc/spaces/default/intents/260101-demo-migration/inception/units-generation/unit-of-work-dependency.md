# Unit of Work Dependency

PU-A-core → PU-B-ui

## Assumptions & Open Questions

### Assumptions

- `[assumption]` PU-B-ui 가 자체 도메인 로직을 갖지 않는다는 전제. 확인되지 않았고 배정된
  자리도 없다.

### Open questions

| 항목 | 배정 |
| --- | --- |
| 두 유닛의 공통 타입을 어디에 두는가 | `functional-design` |
| 생성 코드의 디렉터리 규약 | `code-generation` (`NEW-codegen-layout`) |
| 회귀 기준선 확보 수단 | `build-and-test` (`C22`) |
| 배포 파이프라인 승인자 | 다음 차수 |
| 관측 지표의 정본 | `NEW-metric-source` |
