# I00 — artifacts

`10_ITERATION_MASTER_PLAN` §3 задаёт единый список artifacts для кодовых итераций.
Большая часть из них относится к работающему миру, которого в I00 ещё нет.

| Artifact | Статус в I00 | Когда появится |
|---|---|---|
| `events.jsonl` | неприменимо: canonical events появляются в I02A | I02A |
| `initial.json` / `final.json` | неприменимо: world snapshot появляется в I01 | I01 |
| `world-health.json` | неприменимо: распределения появляются с автономными агентами | I05+ |
| `causal-chains.json` | неприменимо | I07+ |
| `interventions.json` | неприменимо: EcologyController появляется позже | I13E |
| `replay-checksum.txt` | неприменимо: replay-набор наполняется в I02B | I02B |
| `security/` | **есть**: machine-readable результаты пяти проверок | — |
| `limit-checkpoints/` | пусто: usage window ни разу не прерывал работу в этой итерации | при первом прерывании |
| `operations/` | неприменимо: migration/restore/load evidence начинается с I02A/I17 | I02A, I17 |
| `screenshots/` | неприменимо: UI появляется в I03 | I03 |

Отсутствие artifact-а здесь означает «механики ещё нет», а не «evidence потеряно».
