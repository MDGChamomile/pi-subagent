# Astra 출시 후 자식 모델 선택 검토 — 2026-09-05 UTC

## 결론

**운영 프리셋은 Luna / Terra / Sol의 `medium` 3개를 유지하는 편을 권합니다.** 이번 조사에서 Astra 전용 네 번째 프리셋이나 기존 모델 교체를 정당화할 만한 실질적 품질 차이를 확인하지 못했습니다. 이는 Astra의 어려운 작업 성능이 같다는 뜻이 아니라, 이번의 짧고 제한된 작업에서는 추가 비용을 정당화할 근거가 부족했다는 뜻입니다.

**Luna `low`는 다음 두 작업 유형에서 잠정 후보로 확인했습니다.** 각 유형의 low 실행 2회 모두 정답·인용·실제 모델/추론 단계 검사를 통과했습니다. 운영 프리셋이나 지속적인 모델 설정에는 반영하지 않았습니다.

1. 명시된 우선순위에 따라 여러 설정 파일의 최종값을 추출하는 작업입니다.
2. 여러 사건이 섞이고 순서가 뒤바뀐 로그에서 특정 사건의 최초 시각·서비스·기록된 원인을 추출하는 작업입니다.

단순 파일 읽기는 부모가 직접 수행하는 편이 나을 수 있습니다. 위 후보는 자료량이나 독립적인 조사 범위 때문에 이미 위임할 이유가 있을 때 적용할 후보입니다.

## 실행과 중요한 한계

- Pi 0.85.0에서 기존 Codex 구독 경로만 사용했습니다. OpenRouter나 직접 유료 API로 전환하지 않았습니다.
- 합성 작업 7개, 작업별 후보 3~4개, 반복 2회로 **새 자식 실행 46회**를 수행했습니다. 46은 공급자 요청 횟수가 아니라 자식 프로세스 실행 횟수입니다. 자동 재시도는 끄고 동시 실행은 2개로 제한했습니다.
- 작업·정답·채점·실행 코드 해시를 [`protocol.json`](protocol.json)에 먼저 고정했습니다. 실제 production subprocess와 capability guard를 사용하되, 부모의 최종 재서술은 비교에서 제외했습니다.
- **46/46 모두 완전하고 잘리지 않은 결과를 반환했고, 실제 요청 모델·유효 thinking·전송된 reasoning effort·응답 모델 검사를 통과했습니다.** 프리셋 이름이나 결과 metadata만으로 성공을 판단하지 않았습니다.
- low는 임시 agent 디렉터리의 모델 설정에서만 허용했습니다. 프롬프트, 중간 도구 출력, 인증정보는 관찰 로그에 저장하지 않았으며 결과 파일에는 합성 작업의 최종 답변과 사용량을 남겼습니다.

다음 문제를 발견하여 **확증적인 모델 순위나 비열등성 결과로 해석하지 않습니다.**

1. `analysis-capacity`의 `documented_pool_limit`은 배포값 8과 runbook 권장값 20 중 무엇을 묻는지 모호했습니다. 8회 모두 설명에서는 두 값과 장애 원인을 올바르게 구별했습니다. 이 문항은 모델 선택 비교에서 제외했습니다. 원래 문제와 정답을 소급 수정하지 않았습니다.
2. 사전 채점기는 Python `splitlines()`로 줄 수를 세지만 Pi 0.85.0의 read 구현은 `split("\n")`을 사용합니다. 파일 끝 빈 줄까지만 포함한 인용 4건이 엄격한 채점에서 실패했습니다. 이 차이를 반영한 **사후 감도 분석**을 [`measurement-audit.json`](measurement-audit.json)에 별도로 기록했습니다. 실제로 두 줄 수 기준을 모두 벗어난 인용은 Terra의 deadline 작업 3건입니다.
3. 실험 종료 직전에 별도 작업에서 `shared.ts`, `subprocess.ts`, `child-guard.ts`의 partial 결과 처리가 변경됐습니다. 모든 실행이 complete였지만, 실행별 소스 사본을 보관하지 않아 정확히 동일한 소스에서 비교됐다고 보장할 수 없습니다. 변경 사항은 그대로 보존했고 [`runtime-drift.json`](runtime-drift.json)에 기록했습니다. 추가 A/B 실행으로 덮어쓰지 않았습니다.
4. 짧은 합성 작업과 정형 답변을 사용한 소규모 탐색입니다. 긴 저장소 조사, 어려운 실제 결함, 장문 문맥, 웹 검색 품질, high/max 추론은 비교하지 않았습니다. 설명은 부모가 검토했으므로 독립적인 블라인드 평가도 아닙니다.

사전 점수는 33/46입니다. 모호한 문항을 제외한 38회에서는 정답 필드가 모두 맞았고, Pi의 줄 구분을 적용한 사후 인용 검사는 35/38이 통과했습니다. **이 수치를 사전 점수의 수정본이나 일반적인 품질 점수로 사용하지 않습니다.** 검토한 설명에서 모델 선택을 바꿀 만한 실질적 오진이나 안전한 대조군에 대한 거짓 결함은 발견하지 못했습니다.

## 모델 선택에 참고한 관찰

표는 같은 작업의 후보별 2회 중앙값을 비교합니다. 여러 review 작업의 요약은 작업별 중앙값의 합을 비교한 값입니다. 작은 지연 차이에 통계적 의미를 부여하지 않습니다.

| 비교 | 이번 표본에서 관찰한 차이 | 판단 |
|---|---|---|
| Review: Sol medium → Astra medium | 실질적 결론은 같았습니다. Astra의 총 토큰은 약 13%, 출력 토큰은 약 41% 적었지만 API 환산비용은 약 **1.95배**, 시간은 약 5% 길었습니다. | Sol을 유지합니다. |
| Deadline 분석: Terra medium → Astra medium | 계산과 원인 설명은 같았습니다. Astra의 정확한 인용은 2/2, Terra는 1/2였습니다. Astra의 API 환산비용은 약 **3.95배**, 시간은 약 21% 길었습니다. | 인용 차이 한 문항만으로 기본값을 바꾸지 않습니다. |
| Lookup: Luna medium → Astra low | Astra만 해결한 사실 문제가 없었습니다. 더 적은 토큰만으로 Luna 대비 높은 단가를 상쇄하지 못했습니다. | Luna를 유지합니다. |
| Astra medium → Astra low | 작업에 따라 시간이 늘거나 줄었고, 일관된 비용·지연 이득이 없었습니다. | Astra low 전용 프리셋을 추가하지 않습니다. |

Astra의 더 긴 문맥과 어려운 다단계 작업 능력은 별도 전문 프리셋의 후보가 될 수 있지만, 이번에 그 필요성을 직접 검증하지 않았습니다. 공식 문서의 “가장 어려운 작업용”이라는 설명만으로 라우팅을 바꾸지 않습니다.

## low 후보 두 가지

| Luna medium → Luna low | low 정답·인용 검사 | 총 토큰 | 출력 토큰 | 시간 | API 환산비용 |
|---|---:|---:|---:|---:|---:|
| 설정 우선순위에 따른 값 추출 | 2/2 | 약 1.8% 감소 | 약 16.3% 감소 | 약 1.0% 증가, 사실상 차이가 작습니다. | 약 7.1% 감소 |
| 사건 로그에서 제한된 사실 추출 | 2/2 | 약 3.9% 감소 | 약 26.2% 감소 | 약 23.9% 감소 | 약 12.2% 감소 |

두 유형 모두 low에서 답과 인용이 유지됐으므로 **후보로 보고할 근거는 있습니다.** 다만 설정 조회는 지연 이득이 없었고 총 토큰 절감도 작았습니다. 각 유형 2회만으로 `lookup-standard` 전체를 low로 내리거나 low 차단 정책을 전역 해제할 근거는 부족합니다. 추후 추가 검증을 한다면 기존 medium을 유지한 채 명시적인 `lookup-fast` 같은 선택지를 검토하는 편이 안전합니다. 수명주기·복잡한 인과 분석·결함 리뷰에는 이번 결과만으로 low 기본값을 권하지 않습니다.

## 가격 해석

46회 자식 실행의 합계는 공식 standard API 단가로 **약 $1.48934에 해당하는 환산값**입니다. 실제 Codex 청구액, 남은 구독 한도, smoke의 부모·자식 사용량을 뜻하지 않습니다. Codex 한도를 API 달러로 환산할 수 있다는 가정도 하지 않았습니다.

Pi의 로컬 Sol 가격표에는 입력/출력 $5/$30가 남아 있었지만 공식 모델 문서의 $4/$20를 적용했습니다. 원래 Pi usage/cost는 [`results/runs.jsonl`](results/runs.jsonl)에 그대로 남겼으며, 비교용 API 환산값을 별도로 계산했습니다. 입력·캐시 읽기·캐시 쓰기·출력을 구분했습니다.

- [모델 선택 및 Astra 마이그레이션 안내](https://developers.openai.com/api/docs/guides/latest-model)
- [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)

## 테스트 환경 보강

- Pi 관련 devDependency 4개와 lockfile을 0.85.0으로 맞췄습니다.
- 기본 테스트에 Python 검증을 추가했고 테스트 전용 TypeScript observer/worker도 typecheck 대상에 포함했습니다.
- smoke는 현재 runtime preset 목록을 읽어 모두 실행합니다. preset·model·thinking·capability·scope·완전성·사용량·부모의 재조사 금지와 실제 wire 설정을 검사합니다.
- 웹 smoke는 IANA 문서 본문의 documentation-purpose와 registration/transfer 제한 문구를 함께 확인합니다. `example.com`의 짧은 응답을 추출기가 거부하는 문제와, 본문에 제목이 없을 수 있다는 문제를 피했습니다. 도구나 인증의 안전장치를 완화하지 않았습니다.
- 기존 벤치마크 기록은 수정하지 않았습니다. 이번 작업의 파일만 새 날짜 디렉터리에 추가했습니다. 이 작업에서 운영 프리셋·설치된 extension·전역 모델 정책·CI를 변경하거나 커밋/배포하지 않았습니다.

최종 현재 소스에서 TypeScript 테스트 **62개**, Python 테스트 **22개**, typecheck, package check가 통과했습니다. 기존 3개 프리셋의 로컬 3개·웹 3개 smoke도 모두 통과했습니다. 진단 재실행을 포함한 smoke 자식 호출은 총 16회이며, 초기 실패도 삭제하지 않고 [`verification.json`](verification.json)에 함께 기록했습니다.

## 재현 및 보존

- [`tasks.json`](tasks.json): 실행한 합성 자료와 원래 정답입니다.
- [`protocol.json`](protocol.json): 실행 전에 고정한 계획입니다.
- [`results/runs.jsonl`](results/runs.jsonl), [`results/summary.json`](results/summary.json): 수정하지 않은 실행 결과와 사전 채점입니다.
- [`measurement-audit.json`](measurement-audit.json): 문항 모호성과 줄 수 처리에 대한 사후 분석입니다.
- [`runtime-drift.json`](runtime-drift.json): 동시 소스 변경으로 인한 검증 한계입니다.

평가 진입점은 `scripts/model_selection_eval.py`입니다. `--execute`가 없으면 모델을 호출하지 않습니다. 현재 트리에서 이번 protocol을 다시 사용하면 동시 변경된 소스의 해시 때문에 **호출 전에 거부되는 것이 정상**입니다. 재실험은 원래 기록을 수정하거나 다른 작업을 되돌리는 방식이 아니라, 소스 사본을 고정한 새 계획과 새 결과 디렉터리에서 수행해야 합니다.
