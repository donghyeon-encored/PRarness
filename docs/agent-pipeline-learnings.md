# Agent pipeline 문제–해결 및 near-miss 기록

이 문서는 실제 장애뿐 아니라 감사·테스트에서 차단된 **near miss**를 1급
학습 자료로 남긴다. 영향이 없었다는 이유로 버리지 않고, “조건이 조금만
달랐다면 어떤 사고가 되었는가”와 “새로운 사고 유형을 막는 일반화된
방어선은 무엇인가”를 기록한다. 이 접근은 Lorin Hochstein의
[You’re missing your near misses](https://surfingcomplexity.blog/2025/02/01/youre-missing-your-near-misses/)에서
제안한 관점을 이 저장소의 자동화에 적용한 것이다.

## 현재까지의 문제–해결

| 발견된 문제 / near miss | 잠재 영향 | 적용한 해결 | 검증 증거 |
|---|---|---|---|
| 임의 사용자의 canonical state marker 위조 가능성 | 상태 탈취·게시 중단 | GitHub App ID 또는 지정 bot identity가 작성한 최신 marker만 신뢰 | 위조 comment 회귀 테스트 |
| 외부 review/comment가 쓰기 루프를 재개할 가능성 | 무권한 변경 게시 | event gate에서 association, bot, fork, branch를 fail-closed 검사 | 합성 event gate 테스트 |
| Protected 경로의 Issue 범위 승인만으로 All OK 가능 | 검토하지 않은 민감 변경의 Draft 해제 | 범위 승인과 실제 PR head 콘텐츠 승인을 분리하고, 선택 reviewer의 exact-SHA 승인까지 요구 | scope-only 거부 및 exact-head 통과 테스트 |
| 게시 검증 후 PR/default branch가 바뀔 수 있음 | 검증한 대상과 게시 대상 불일치 | App write token 발급 직전과 publisher 내부에서 live repository/PR/ref/SHA/lifecycle 재검증 | closed PR·stale head 회귀 테스트 |
| 닫힌 PR 뒤 동일 branch의 새 PR 생성 가능 | issue당 PR 하나 불변식 파괴 | canonical PR이 closed/merged이면 재생성하지 않고 HUMAN_REQUIRED/fail-closed | lifecycle 테스트 |
| 결정론적 high risk가 다음 fix iteration에서 low로 하향 | 부적격 reviewer 선택 | prior high를 sticky하게 유지하고 triage domain/privacy 근거를 `risk_context`로 전달 | high-risk downgrade 회귀 테스트 |
| dispatch/resume의 API 보강 event가 후속 agent에 전달되지 않음 | 빈 Issue 내용, PR author 제외 우회 | gate가 enriched event를 canonical `event.json`으로 원자적으로 출력 | workflow contract 및 CLI 출력 검사 |
| 줄바꿈·비ASCII 파일명을 줄 단위로 처리 | protected-path/risk 검사 누락 | `git diff -z` → 결정론적 NUL parser → JSON 배열 계약으로 통일 | 특수 파일명 회귀 테스트 |
| `fix_required`인데 actionable finding이 없음 | 무의미한 자동 iteration 소모 | schema/runtime에서 must-fix finding을 필수화하고 pass+must-fix도 거부 | agent-output 경계 테스트 |
| 모델이 staged한 변경 또는 untracked 파일이 patch에서 누락 | 검증과 게시 diff 불일치 | HEAD 기준 binary patch와 fresh-runner 재적용 사용 | tracked/untracked/rename patch 테스트 |
| root validation command가 실행 불가 | 모든 publishable 변경 차단 | root npm script가 신뢰된 pipeline lint/test를 위임하도록 최소 package 계약 추가 | root `npm run lint`, `npm test` |
| 커밋·PR 범위가 암묵적이라 unrelated 변경이나 과대 diff를 허용 | review 부담 증가와 rollback 단위 붕괴 | 커밋은 feature/fix CRUD 한 묶음, PR은 한 의미 단위로 정책화; 200줄은 목표이고 작은 PR은 허용, 400줄 초과는 `SPLIT_REQUIRED`와 최소 PR 수를 산출, binary는 HUMAN_REQUIRED | 1/199/200/400/401 및 binary 경계 테스트 |
| high-risk 기준이 짧은 keyword 목록에 머물거나 반대로 category 단어만으로 high가 될 수 있음 | 중대 위험 누락과 1% 수준 변화의 과잉 분류 | 13개 category와 `equivalent_severity`를 공유하되 일반 signal은 후보로만 기록하고, 구조화된 impact/likelihood/blast-radius/reversibility/detectability 또는 구체적 high-impact signal로 materiality를 판정 | category 후보/고충격 signal, 1% resource delta, equivalent-severity 회귀 테스트 |
| 하나의 Issue를 여러 PR로 분할할 때 모델이 problem/변경 경로를 두 unit에 중복 배정하거나 하나를 누락시킬 수 있음 | 동일 파일을 서로 다른 브랜치에서 동시에 편집하는 충돌, 또는 어떤 unit도 책임지지 않는 미해결 problem | 모든 problem과 changed_path가 정확히 하나의 unit에만 속해야 split을 승인; 하나라도 어긋나면 통째로 거부하고 단일 PR로 fallback. canonical state comment도 unit별로 완전히 분리해 PR 번호/브랜치/unit id로만 조회하고, disambiguator가 없는 조회(예: 순수 issue 댓글 트리거)는 항상 unit:null 개요 thread로만 향하게 하여 임의 unit을 잘못 재개하는 것을 방지 | 경로 중복, problem 누락, 중복 unit id 회귀 테스트; PR/branch/unit 조회 disambiguation 테스트 |

## 기록 기준

다음 중 하나면 실제 영향이 0이어도 이 문서에 추가한다.

- 권한·신뢰 경계가 테스트나 감사 덕분에 우연히 넘지 않은 경우
- 검증한 SHA/경로/상태와 게시 대상이 달라질 수 있었던 경우
- fail-open 기본값, 누락된 입력, 상태 전이 dead-end를 발견한 경우
- 새로운 사건 유형을 막는 일반화된 불변식이나 회귀 테스트를 얻은 경우

각 항목은 최소한 `문제 → 잠재 영향 → 해결 → 재현/검증`을 포함한다.
개인의 실수보다 당시 시스템이 왜 그 행동을 허용했는지에 초점을 둔다.

## 남아 있는 운영 의존성

GitHub는 workflow YAML을 job 내부 gate보다 먼저 해석한다. 따라서 같은
저장소의 신뢰되지 않은 사용자가 workflow 파일을 바꾼 PR을 실행하고
repository secret에 접근할 수 있는 권한 모델이라면, 단일 workflow 내부
검사만으로 그 실행 정의 자체를 보호할 수 없다. 이 저장소는 agent가
`.github/workflows/**`를 수정하는 경로를 무조건 차단하지만, 운영 저장소에서도
다음을 별도로 강제해야 한다.

- workflow 변경에 CODEOWNERS 승인과 보호 branch review 요구
- Actions 실행 권한을 신뢰된 collaborator로 제한
- 신뢰되지 않은 same-repository branch를 허용해야 한다면 secret 없는 collector와
  default-branch 전용 publisher workflow로 권한 분리

이 운영 의존성이 충족되지 않은 환경에서는 App private key를 활성화하지 않는다.
