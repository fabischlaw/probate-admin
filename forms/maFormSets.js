'use strict';

const MA_FORM_SETS = {
  voluntary: {
    label: "Voluntary Administration",
    fee: 115,
    always: ["MPC-170"],
    conditional: {
      "MPC-485": "domicileMismatch",
      "MPC-475": "causeOfDeathPending"
    }
  },
  informalIntestate: {
    label: "Informal Probate — Intestate",
    fee: 390,
    always: ["MPC-150", "MPC-162", "MPC-550", "MPC-750", "MPC-801"],
    requiredUnlessAllAssent: ["MPC-470"],
    conditional: {
      "MPC-455": "renunciationOrNominationOrWaiver",
      "MPC-485": "domicileMismatch",
      "MPC-475": "causeOfDeathPending",
      "MPC-551": "postAllowance"
    }
  },
  informalTestate: {
    label: "Informal Probate — Testate",
    fee: 390,
    always: ["MPC-150", "MPC-162", "MPC-163", "MPC-550", "MPC-750", "MPC-801"],
    requiredUnlessAllAssent: ["MPC-470"],
    conditional: {
      "MPC-455": "renunciationOrNominationOrWaiver",
      "MPC-485": "domicileMismatch",
      "MPC-475": "causeOfDeathPending",
      "MPC-551": "postAllowance"
    }
  },
  formalIntestate: {
    label: "Formal Probate — Intestate",
    fee: 405,
    always: ["MPC-160", "MPC-162", "MPC-560", "MPC-755", "MPC-801"],
    requiredUnlessAllAssent: ["MPC-470"],
    conditional: {
      "MPC-455": "renunciationOrNominationOrWaiver",
      "MPC-485": "domicileMismatch",
      "MPC-475": "causeOfDeathPending",
      "CCF-407": "attorneyAppearing"
    }
  },
  formalTestate: {
    label: "Formal Probate — Testate",
    fee: 405,
    always: ["MPC-160", "MPC-162", "MPC-163", "MPC-560", "MPC-755", "MPC-801"],
    requiredUnlessAllAssent: ["MPC-470"],
    conditional: {
      "MPC-455": "renunciationOrNominationOrWaiver",
      "MPC-480": "noAttestationClause",
      "MPC-485": "domicileMismatch",
      "MPC-475": "causeOfDeathPending",
      "CCF-407": "attorneyAppearing"
    }
  },
  lateAndLimited: {
    label: "Late & Limited Formal",
    fee: 405,
    always: ["MPC-161", "MPC-162", "MPC-560", "MPC-757", "MPC-801"],
    requiredUnlessAllAssent: ["MPC-470"],
    conditional: {
      "MPC-163": "testate",
      "MPC-455": "renunciationOrNominationOrWaiver",
      "MPC-480": "noAttestationClause",
      "MPC-485": "domicileMismatch",
      "MPC-475": "causeOfDeathPending",
      "CCF-407": "attorneyAppearing"
    },
    warning: "PR authority is LIMITED — can only confirm title in successors and pay admin expenses. Cannot sell real estate. Letters must note this limitation."
  }
};

const MA_FORM_LABELS = {
  "MPC-150":  "MPC 150 — Petition for Informal Probate/Appointment",
  "MPC-160":  "MPC 160 — Petition for Formal Probate/Appointment",
  "MPC-161":  "MPC 161 — Petition for Late & Limited Formal",
  "MPC-162":  "MPC 162 — Surviving Spouse, Children, Heirs at Law",
  "MPC-163":  "MPC 163 — Devisees",
  "MPC-170":  "MPC 170 — Voluntary Administration Statement",
  "MPC-455":  "MPC 455 — Assent/Waiver/Renunciation/Nomination",
  "MPC-470":  "MPC 470 — Military Affidavit",
  "MPC-475":  "MPC 475 — Cause of Death Affidavit",
  "MPC-480":  "MPC 480 — Affidavit of Witness to Will",
  "MPC-485":  "MPC 485 — Affidavit of Domicile",
  "MPC-550":  "MPC 550 — Notice of Informal Probate & Return of Service",
  "MPC-551":  "MPC 551 — Informal Probate Publication Notice",
  "MPC-560":  "MPC 560 — Citation for Formal Adjudication (court-issued)",
  "MPC-750":  "MPC 750 — Order of Informal Probate/Appointment",
  "MPC-755":  "MPC 755 — Decree and Order on Formal Adjudication",
  "MPC-757":  "MPC 757 — Decree and Order — Late & Limited",
  "MPC-801":  "MPC 801 — Bond",
  "CCF-407":  "CCF 4/07 — Uniform Counsel Certification",
  "MPC-850":  "MPC 850 — Closing Statement",
  "MPC-851":  "MPC 851 — Small Estate Closing Statement",
  "MPC-853":  "MPC 853 — Account",
  "MPC-854":  "MPC 854 — Inventory",
  "MPC-855":  "MPC 855 — Petition for Order of Complete Settlement",
  "MPC-857":  "MPC 857 — Petition for Allowance of Account",
  "MPC-360":  "MPC 360 — Demand for Sureties",
  "MPC-505a": "MPC 505a — Notice of Appearance and Objection"
};

// Closing and accounting forms — used during administration, not part of the
// initial filing. Listed in the recommended filing order.
const MA_CLOSING_FORMS = [
  "MPC-854",   // Inventory — due within 3 months of appointment
  "MPC-850",   // Closing Statement
  "MPC-851",   // Small Estate Closing Statement
  "MPC-853",   // Account
  "MPC-855",   // Petition for Order of Complete Settlement
  "MPC-857",   // Petition for Allowance of Account
];

module.exports = { MA_FORM_SETS, MA_FORM_LABELS, MA_CLOSING_FORMS };
