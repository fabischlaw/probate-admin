# DecisionVault Field Gap Tracker

This document tracks fields needed for Massachusetts and Rhode Island 
probate form filling that may not be captured in DecisionVault by default.
Review with DecisionVault account settings to determine which can be added
as custom fields.

## Status Key
- ✅ Confirmed in DecisionVault API
- ⚠️ Needs verification — may exist under different field name
- ❌ Not available — needs custom field or manual toggle in app
- 🔄 Handled by app toggle (user inputs at time of filing)

---

## Decedent Information

| Field | Status | Notes |
|---|---|---|
| Full legal name | ✅ | |
| Date of death | ✅ | |
| Domicile address at death | ✅ | |
| County of domicile | ⚠️ | Not a matter field; derivable from city for RI via cityToCounty(). MA requires separate mapping (e.g. North Attleboro → Bristol County). |
| Domicile matches death certificate | 🔄 | App toggle |
| Cause of death | ❌ | No `cause_of_death` field in API. MPC-475 trigger must rely on user toggle only. |
| Whether death certificate is official/certified | 🔄 | App toggle |
| Date of birth | ✅ | Confirmed: `date_of_birth` present on all contact objects |
| Social Security Number | ❌ | Not in API. Must be entered manually on printed form. |

---

## Estate Information

| Field | Status | Notes |
|---|---|---|
| Total estate value | ✅ | Pulled from assets |
| Personal property value (approx) | ✅ | Derived from assets |
| Real estate detected | ✅ | Derived from assets |
| Whether estate includes registered land | 🔄 | App toggle |
| Personal property value excluding vehicles | ⚠️ | Vehicles may not be tagged separately |
| Whether voluntary admin eligible | ✅ | Computed by app |

---

## Interested Parties

| Field | Status | Notes |
|---|---|---|
| Surviving spouse name and address | ✅ | |
| Children names and addresses | ✅ | |
| Heirs at law names and addresses | ✅ | |
| Relationship to decedent | ✅ | |
| Whether any heir/devisee is a minor | ✅ | `date_of_birth` confirmed on all contacts; app computes age at time of filing |
| Whether each child is also a child of the surviving spouse | ❌ | Required for MPC-162 Q2. Not captured in DV. Must be answered manually per child. Consider per-child toggle in future UI update. |
| Whether any heir/devisee is incapacitated | 🔄 | App toggle |
| Whether minor/IP has conservator or guardian | 🔄 | App toggle |
| Whether any since-deceased heir has appointed PR | 🔄 | App toggle |
| Whether any interested person is in military | 🔄 | App toggle |
| Docket number of any guardianship/conservatorship | ❌ | Needs custom field |

---

## Personal Representative

| Field | Status | Notes |
|---|---|---|
| Nominated PR name | ✅ | Confirmed: contact with `is_client=true` and `rel.type=0CLNT` is the rep; also in `matter.contact_representative` |
| Nominated PR address | ✅ | Confirmed: full address in `addresses[0]` array on contact object |
| Petitioner email | ✅ | MPC-160 uses `Q2_Email_83`. MPC-150 (PFC0010) uses `Q2_Phone_77` (probe-confirmed email field; misleading name is a court form designer artifact). MPC-161 has no Q2 email field. |
| PR priority basis | 🔄 | App toggle / will upload |
| Whether PR has statutory priority | 🔄 | App toggle |
| Whether PR is a creditor | 🔄 | App toggle |
| Whether PR is a public administrator | 🔄 | App toggle |
| Whether PR is a bank/trust company | 🔄 | App toggle |
| Renunciation/nomination chain | 🔄 | App toggle / will upload |

---

## Will Information (Testate Proceedings)

| Field | Status | Notes |
|---|---|---|
| Will execution date | ❌ | Not in DV API. User must enter manually in UI for testate proceedings (willDate field in Case Facts). |
| Whether original will exists | 🔄 | App toggle |
| Whether will has interlineations or deletions | 🔄 | App toggle |
| Whether will has attestation clause | 🔄 | App toggle / will upload |
| Whether will waives sureties | 🔄 | App toggle / will upload (Phase 2C) |
| Whether will allows PR to nominate successor | 🔄 | Will upload (Phase 2C) |
| Named PR in will | 🔄 | Will upload (Phase 2C) |
| Alternate PR named in will | 🔄 | Will upload (Phase 2C) |
| Devisees named in will | 🔄 | Will upload (Phase 2C) |
| Residuary beneficiaries | 🔄 | Will upload (Phase 2C) |

---

## Proceeding-Specific

| Field | Status | Notes |
|---|---|---|
| Whether supervised administration needed | 🔄 | App toggle (`supervisedRequired`); MPC-160 Q12 parent (Q12_UnsupervisedAdmin_239 / Q12_SupervisedAdmin_247) and sub-reason (Q12_WillDirectsUnsupervisedAdmin_243 for testate, Q12_DecedentDiedWithoutWill_244 for intestate, Q12_DirectsSupervisedAdmin_249 for supervised testate, Q12_NoWillDirectsSupervisedAdmin_253 for supervised intestate) are all auto-populated |
| Whether registered land in estate | 🔄 | App toggle |
| Whether divorce within 90 days of death (nisi) | ❌ | No `divorce_date` field in API; `contact_main_marital_status` gives "divorced" but not date. Nisi period check must rely on user toggle only. |
| DMA notice sent date | ❌ | Not in API; needs manual entry or custom DV field |
| Publication newspaper name | ❌ | Not in API; needs custom DV field |
| Return date (formal proceedings) | ❌ | Court-assigned; manual entry |
| Court division/county | ⚠️ | No `county` on matter; RI derivable via cityToCounty(); MA needs separate mapping |
| Prior informal proceeding docket number | 🔄 | App toggle (priorInformalDocketNumber); shown for formalIntestate/formalTestate; fills Q13_PriorInformalFindings_275, Q13_PrioirInformalApptPetRep_276, LG1_279 in MPC-160 |

---

## Fields to Add as Custom Fields in DecisionVault
*(Confirmed missing from API as of 2026-05-03 real-matter test — Ziegler matter)*

1. **SSN/EIN** for decedent — required on petitions; must be entered manually on printed form
2. **County of domicile** — MA matters need explicit county or an MA city→county lookup table in app
3. **DMA notice sent date** — compliance tracking; not in API
4. **Publication newspaper** — required for informal probate notice; not in API
5. **Cause of death** — triggers MPC-475 requirement; no field in API
6. **Docket numbers** for related guardianship/conservatorship cases
7. **Divorce date** — nisi period calculation; only marital status string available
8. **Child of surviving spouse (per child)** — required for MPC-162 Q2; consider per-child toggle in UI

*Confirmed available — no custom field needed:*
- **Date of birth** — ✅ `date_of_birth` on all contacts; minor detection computed by app
- **Nominated PR name/address** — ✅ `is_client=true` contact and `contact_representative`

---

## Notes
- This document should be updated as form fillers are built and 
  actual PDF field mappings are confirmed
- Fields marked ⚠️ should be verified against the DecisionVault API 
  response for a real matter before building the filler
- Phase 2C (will upload) will resolve many of the 🔄 items for 
  testate proceedings automatically
