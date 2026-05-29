'use strict';

const { FIRM_PROFILE } = require('../forms/common');

function todayLong() {
  return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function displayDate(isoOrSlash) {
  if (!isoOrSlash) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(isoOrSlash)) return isoOrSlash;
  const [y, m, d] = isoOrSlash.split('-');
  return `${m}/${d}/${y}`;
}

function firmHeader() {
  return [
    FIRM_PROFILE.firmName,
    FIRM_PROFILE.address,
    `${FIRM_PROFILE.city}, ${FIRM_PROFILE.state} ${FIRM_PROFILE.zip}`,
    FIRM_PROFILE.phone,
    FIRM_PROFILE.email,
  ].join('\n');
}

function sig() {
  return `Sincerely,\n\n${FIRM_PROFILE.attorneyNameFull}\n${FIRM_PROFILE.firmName}\nBBO # ${FIRM_PROFILE.bbo}`;
}

const LETTER_TEMPLATES = [
  {
    id: 'initial_client',
    label: 'Initial Client Letter',
    description: 'Welcome letter confirming representation and outlining next steps',
    generate(adminData, matterData) {
      const { decedentName, representativeName, dateOfDeath, state } = matterData;
      const stateName = state === 'RI' ? 'Rhode Island' : 'Massachusetts';

      // Build key deadlines block
      const dl = adminData.deadlines || [];
      const inv  = dl.find(d => d.key === 'inventory');
      const cred = dl.find(d => d.key === 'creditor_claim_period');
      const tax  = dl.find(d => d.key === 'estate_tax_return');
      const f1040 = dl.find(d => d.key === 'final_1040_due');

      const deadlineLines = [
        inv   ? `• Inventory filing deadline:         ${inv.dueDateDisplay}  (${inv.statute})` : null,
        cred  ? `• Creditor claim period closes:      ${cred.dueDateDisplay}  (${cred.statute})` : null,
        tax   ? `• Estate tax return due (if taxable): ${tax.dueDateDisplay}  (${tax.statute})` : null,
        f1040 ? `• Decedent's final income tax return: ${f1040.dueDateDisplay}` : null,
      ].filter(Boolean).join('\n');

      return `${todayLong()}

${firmHeader()}

Re: Estate of ${decedentName}
    Date of Death: ${displayDate(dateOfDeath)}

Dear ${representativeName},

Thank you for choosing ${FIRM_PROFILE.firmName} to assist you with the administration of the Estate of ${decedentName}. We are honored to serve you during this difficult time.

This letter confirms that we are representing you as the Personal Representative (or prospective Personal Representative) of the above-referenced estate.

NEXT STEPS

To move forward, we will need the following from you:

1. Certified copies of the death certificate (we recommend ordering at least 6–8 copies).
2. The original will, if the decedent left one.
3. A list of all known assets and their estimated values, including bank accounts, investment accounts, real estate, vehicles, and personal property.
4. Names, addresses, and relationships of all heirs and/or beneficiaries.

WHAT WE WILL DO

Once we have gathered the necessary information, we will prepare the probate petition and supporting forms for filing with the ${stateName} Probate Court. We will guide you through each step of the administration process, including meeting all court deadlines.

Please do not distribute any assets or pay any debts until we have advised you to do so. If you receive any creditor claims or correspondence regarding the estate, please forward them to our office immediately.${deadlineLines ? `

KEY DEADLINES (based on dates provided)

${deadlineLines}

Please note that some deadlines are conditional on estate value or other factors. We will advise you which apply as administration proceeds.` : ''}

If you have any questions, please contact us at ${FIRM_PROFILE.phone} or ${FIRM_PROFILE.email}.

${sig()}`;
    },
  },

  {
    id: 'engagement',
    label: 'Engagement / Retainer Letter',
    description: 'Formal engagement letter with fee agreement',
    generate(adminData, matterData) {
      const { decedentName, representativeName, dateOfDeath } = matterData;
      return `${todayLong()}

${firmHeader()}

Re: Engagement Letter — Estate of ${decedentName}${matterData.docketNo ? `\n    Docket No.: ${matterData.docketNo}` : ''}

Dear ${representativeName},

This letter confirms the terms of our engagement to represent you in connection with the probate and administration of the Estate of ${decedentName} (Date of Death: ${displayDate(dateOfDeath)}).

SCOPE OF REPRESENTATION

We will represent you as Personal Representative in connection with:
• Preparation and filing of the probate petition and all supporting forms
• Correspondence with the Probate & Family Court
• Advice regarding your duties and obligations as Personal Representative
• Preparation of the estate inventory
• Guidance through the administration process, including the creditor claim period
• Preparation of closing documents

Not included without separate written agreement: estate tax returns, real estate conveyancing, litigation.

FEES

Our fees for probate services are [FEE ARRANGEMENT]. A retainer of $[AMOUNT] is due upon signing this letter.

AUTHORIZATION

By signing below, you authorize ${FIRM_PROFILE.firmName} to act as your legal counsel in the above-referenced matter.

Please sign and return one copy of this letter to our office along with the retainer payment.

${sig()}

AGREED AND ACCEPTED:

_________________________        Date: __________
${representativeName}
Personal Representative, Estate of ${decedentName}`;
    },
  },

  {
    id: 'dma_notice',
    label: 'DMA Notice Cover Letter',
    description: 'Cover letter for MassHealth Estate Recovery Unit notice (MA)',
    generate(adminData, matterData) {
      const { decedentName, dateOfDeath } = matterData;
      const hasWill = adminData.toggleAnswers?.hasWill || false;
      return `${todayLong()}

${firmHeader()}

VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED

MassHealth Estate Recovery Unit
P.O. Box 15205
Worcester, MA 01615-0205

Re: Notice of Probate Petition — Estate of ${decedentName}
    Date of Death: ${displayDate(dateOfDeath)}

To Whom It May Concern:

Pursuant to G.L. c. 190B § 3-306 and 130 C.M.R. 515.014, please be advised that a Petition for Informal ${hasWill ? 'Probate of Will and ' : ''}Appointment of Personal Representative has been filed (or is being filed) in the ${matterData.division || '[DIVISION]'} Division of the Probate & Family Court with respect to the above-referenced estate.

Enclosed herewith, please find:
• A copy of the signed petition
• A copy of the death certificate

This notice is provided at least seven (7) days prior to the filing of the petition, as required by statute.

${sig()}

Enclosures`;
    },
  },

  {
    id: 'heir_notice',
    label: 'Notice to Heir / Interested Party',
    description: 'Notice letter to heirs and beneficiaries of pending petition',
    generate(adminData, matterData) {
      const { decedentName, dateOfDeath, docketNo, division } = matterData;
      return `${todayLong()}

${firmHeader()}

VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED

[HEIR NAME]
[HEIR ADDRESS]

Re: Notice of Probate Proceeding — Estate of ${decedentName}
    Date of Death: ${displayDate(dateOfDeath)}
    Docket No.: ${docketNo || '[DOCKET NUMBER]'}
    Court: ${division || '[DIVISION]'} Division, Probate & Family Court

Dear [HEIR NAME]:

Please be advised that a petition for the probate of the estate of ${decedentName} has been filed with the Probate & Family Court. You are identified as an interested party in this proceeding.

If you wish to contest the appointment of the Personal Representative or any aspect of this proceeding, you must file a written objection with the Court within the time permitted by law.

If you have any questions, please contact our office at ${FIRM_PROFILE.phone}.

${sig()}`;
    },
  },

  {
    id: 'creditor_notice',
    label: 'Creditor Notice Letter',
    description: 'Letter to known creditors of the estate',
    generate(adminData, matterData) {
      const { decedentName, dateOfDeath, docketNo, division, representativeName, state } = matterData;
      const credDl = (adminData.deadlines || []).find(d => d.key === 'creditor_claim_period');
      const isRI = state === 'RI';
      const statute = isRI ? 'R.I. Gen. Laws § 33-12-4' : 'G.L. c. 190B § 3-803';
      const deadlineText = isRI
        ? 'six (6) months from the date of first publication of the notice to creditors'
        : 'one (1) year from the date of death';
      return `${todayLong()}

${firmHeader()}

VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED

[CREDITOR NAME]
[CREDITOR ADDRESS]

Re: Estate of ${decedentName} — Notice to Creditor
    Docket No.: ${docketNo || '[DOCKET NUMBER]'}
    Court: ${division || '[DIVISION]'} Division, Probate${isRI ? '' : ' & Family'} Court

Dear Sir or Madam:

Please be advised that ${decedentName} passed away on ${displayDate(dateOfDeath)}. Letters of Authority have been issued to ${representativeName}, Personal Representative of the above-referenced estate.

Pursuant to ${statute}, creditors must present their claims within ${deadlineText}, or be forever barred.${credDl ? ` The deadline for presenting claims in this estate is ${credDl.dueDateDisplay}.` : ''} To present a claim, submit written notice to our office including the amount claimed and its basis.

${sig()}
On behalf of the Personal Representative`;
    },
  },

  {
    id: 'asset_inquiry',
    label: 'Asset / Account Inquiry Letter',
    description: 'Letter to financial institutions requesting account information',
    generate(adminData, matterData) {
      const { decedentName, dateOfDeath, representativeName, docketNo } = matterData;
      return `${todayLong()}

${firmHeader()}

[INSTITUTION NAME]
[INSTITUTION ADDRESS]

Re: Estate of ${decedentName} — Request for Account Information
    Date of Death: ${displayDate(dateOfDeath)}
    Personal Representative: ${representativeName}
    Docket No.: ${docketNo || '[DOCKET NUMBER]'}

To Whom It May Concern:

This office represents ${representativeName}, the duly appointed Personal Representative of the Estate of ${decedentName}. Enclosed please find a certified copy of the Letters of Authority.

We request the following as of the date of death:
1. Account number(s) and type(s)
2. Balance as of the date of death
3. Any beneficiary designations on file
4. Any outstanding loans or liens against the account

Please provide the requested information within fifteen (15) days of receipt. If additional documentation is required, please contact our office promptly.

${sig()}

Enclosure: Certified Letters of Authority`;
    },
  },

  {
    id: 'inventory_cover',
    label: 'Inventory Filing Cover Letter',
    description: 'Cover letter for filing the estate inventory with the court',
    generate(adminData, matterData) {
      const { decedentName, docketNo, division } = matterData;
      const invDeadline = (adminData.deadlines || []).find(d => d.key === 'inventory');
      return `${todayLong()}

${firmHeader()}

Register of Probate
${division || '[DIVISION]'} Division, Probate & Family Court
[COURT ADDRESS]

Re: Estate of ${decedentName}
    Docket No.: ${docketNo || '[DOCKET NUMBER]'}

Dear Register of Probate:

Enclosed herewith please find the Inventory (MPC 854) for the above-referenced estate${invDeadline ? `, due ${invDeadline.dueDateDisplay}` : ''}.

Please file the enclosed inventory and return a date-stamped copy to our office in the self-addressed stamped envelope provided.

${sig()}

Enclosures: MPC 854 — Inventory (original + 1 copy)
            Self-addressed stamped envelope`;
    },
  },

  {
    id: 'status_update',
    label: 'Client Status Update',
    description: 'Periodic status update letter to the client',
    generate(adminData, matterData) {
      const { decedentName, representativeName } = matterData;

      // Next 3 upcoming deadlines (status upcoming, urgent, or future — not overdue or na)
      const upcoming = (adminData.deadlines || [])
        .filter(d => d.daysUntil !== null && d.daysUntil >= 0)
        .sort((a, b) => a.daysUntil - b.daysUntil)
        .slice(0, 3);

      const deadlineBlock = upcoming.length > 0
        ? upcoming.map(d => `• ${d.label}: ${d.dueDateDisplay} (${d.daysUntil} days)`).join('\n')
        : '[No upcoming deadlines calculated — enter key dates in the Administration tab]';

      return `${todayLong()}

${firmHeader()}

Re: Estate of ${decedentName} — Status Update

Dear ${representativeName},

We are writing to provide you with an update on the administration of the Estate of ${decedentName}.

CURRENT STATUS

[INSERT CURRENT STATUS / STAGE]

RECENT ACTIVITY

[INSERT RECENT ACTIONS TAKEN]

PENDING ITEMS / NEXT STEPS

[INSERT NEXT STEPS AND ANY ACTION REQUIRED FROM YOU]

UPCOMING DEADLINES

${deadlineBlock}

Please do not hesitate to contact our office if you have any questions or concerns. We will continue to keep you informed of significant developments.

${sig()}`;
    },
  },

  {
    id: 'distribution',
    label: 'Distribution Letter',
    description: 'Letter to beneficiaries accompanying their distribution',
    generate(adminData, matterData) {
      const { decedentName, docketNo } = matterData;
      return `${todayLong()}

${firmHeader()}

[BENEFICIARY NAME]
[BENEFICIARY ADDRESS]

Re: Estate of ${decedentName} — Distribution
    Docket No.: ${docketNo || '[DOCKET NUMBER]'}

Dear [BENEFICIARY NAME]:

We are pleased to inform you that the administration of the Estate of ${decedentName} is now at the distribution stage. Enclosed please find [a check in the amount of $[AMOUNT] / a transfer of the following asset(s): [DESCRIPTION]], representing your [share / specific bequest] under the [will / laws of intestate succession].

Please sign the enclosed Receipt and Release and return it to our office at your earliest convenience.

${sig()}
On behalf of the Personal Representative

Enclosures: Distribution / asset transfer documentation
            Receipt and Release
            Self-addressed stamped envelope`;
    },
  },

  {
    id: 'closing',
    label: 'Closing Letter',
    description: 'Final letter confirming estate administration is complete',
    generate(adminData, matterData) {
      const { decedentName, representativeName, docketNo } = matterData;
      return `${todayLong()}

${firmHeader()}

Re: Estate of ${decedentName} — Administration Complete
    Docket No.: ${docketNo || '[DOCKET NUMBER]'}

Dear ${representativeName},

We are pleased to advise you that the administration of the Estate of ${decedentName} is now complete. The closing statement has been filed with the Probate & Family Court, all distributions have been made, and all required documentation has been submitted.

As Personal Representative, you have successfully fulfilled your obligations to the estate and its beneficiaries. Our representation in connection with this estate is hereby concluded.

Please retain copies of all estate records for at least seven (7) years.

It has been our privilege to assist you through this process.

${sig()}`;
    },
  },
  // ── Trust Letter Templates ───────────────────────────────────────────────────

  {
    id: 'letter_trustee_affidavit',
    label: 'Affidavit of Successor Trustee',
    description: 'Affidavit confirming successor trustee appointment (for recording with financial institutions)',
    generate(adminData, matterData) {
      const { decedentName, representativeName, dateOfDeath } = matterData;
      return `${todayLong()}

${firmHeader()}

AFFIDAVIT OF SUCCESSOR TRUSTEE

STATE OF ${matterData.state === 'RI' ? 'RHODE ISLAND' : 'MASSACHUSETTS'}
COUNTY OF [COUNTY]

I, ${representativeName}, being duly sworn, do hereby state as follows:

1. I am the duly appointed Successor Trustee of the [TRUST NAME] (the "Trust") originally established by ${decedentName} (the "Settlor").

2. ${decedentName} passed away on ${displayDate(dateOfDeath)}, and as a result, I have become the Successor Trustee of the Trust pursuant to the terms of the Trust instrument dated [TRUST DATE].

3. The Trust continues in full force and effect. No order of court has been entered modifying, revoking, or terminating the Trust.

4. As Successor Trustee, I am authorized to exercise all powers granted to the Trustee under the Trust instrument, including but not limited to the power to open and manage bank accounts, purchase and sell assets, and enter into contracts on behalf of the Trust.

5. Attached hereto as Exhibit A is a true and correct copy of the relevant sections of the Trust instrument establishing my authority.

Signed under the pains and penalties of perjury this ${todayLong()}.

_________________________
${representativeName}, Successor Trustee
[TRUST NAME]

Subscribed and sworn to before me this _____ day of _____________, 20___.

_________________________
Notary Public
My Commission Expires: ___________

${sig()}`;
    },
  },

  {
    id: 'letter_certification_of_trust',
    label: 'Certification of Trust',
    description: 'Certification of trust for financial institutions (without disclosing full trust terms)',
    generate(adminData, matterData) {
      const { decedentName, representativeName, dateOfDeath, state } = matterData;
      const statute = state === 'RI' ? 'R.I. Gen. Laws § 18-9.1-13' : 'M.G.L. c. 203E § 1013';
      return `${todayLong()}

${firmHeader()}

CERTIFICATION OF TRUST

Pursuant to ${statute}

The undersigned hereby certifies the following information regarding the trust described herein:

1. TRUST NAME AND DATE: [TRUST NAME], established by Declaration of Trust dated [TRUST DATE].

2. SETTLOR: ${decedentName} (Date of Death: ${displayDate(dateOfDeath)}).

3. CURRENT TRUSTEE: ${representativeName}, Successor Trustee.

4. TRUST STATUS: The Trust is currently in existence and has not been revoked, modified, or terminated.

5. TRUSTEE AUTHORITY: The Trustee has the full power and authority to:
   • Open and maintain bank, brokerage, and other financial accounts
   • Buy, sell, transfer, and manage trust assets
   • Execute documents and enter into agreements on behalf of the Trust
   • Exercise all other powers set forth in the Trust document

6. TAX IDENTIFICATION: The Trust's federal taxpayer identification number is: ___-___________

7. LIMITATIONS: [NONE / DESCRIBE ANY RELEVANT LIMITATIONS]

The undersigned certifies that the foregoing is true and correct as of the date hereof, and that the Trust instrument has not been revoked, modified, or amended in any manner that would cause the representations set forth in this certification to be incorrect.

This certification is furnished in lieu of the full trust instrument pursuant to the statutory authority cited above.

_________________________        Date: __________
${representativeName}, Successor Trustee
[TRUST NAME]

${sig()}`;
    },
  },

  {
    id: 'letter_trustee_notice_to_beneficiaries',
    label: 'Trustee Notice to Beneficiaries',
    description: 'Statutory notice of trustee appointment to all trust beneficiaries',
    generate(adminData, matterData) {
      const { decedentName, representativeName, dateOfDeath, state } = matterData;
      const statute = state === 'RI' ? 'R.I. Gen. Laws § 18-9.1-8.13' : 'M.G.L. c. 203E § 813';
      const trustDl = (adminData.deadlines || []).find(d => d.key === 'trustee_beneficiary_notice');
      return `${todayLong()}

${firmHeader()}

VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED

[BENEFICIARY NAME]
[BENEFICIARY ADDRESS]

Re: Notice of Trustee Appointment — [TRUST NAME]
    (Pursuant to ${statute})

Dear [BENEFICIARY NAME]:

You are receiving this notice because you are a beneficiary of the [TRUST NAME] (the "Trust") established by ${decedentName}.

${decedentName} passed away on ${displayDate(dateOfDeath)}. I, ${representativeName}, have accepted appointment as Successor Trustee of the Trust pursuant to its terms. This notice is required by law to be sent to all beneficiaries within 60 days of my appointment.${trustDl ? `\n\nMy appointment became effective on [APPOINTMENT DATE]. This notice is being provided by the required deadline of ${trustDl.dueDateDisplay}.` : ''}

BENEFICIARY RIGHTS

As a beneficiary of the Trust, you have the right to:
1. Request a copy of the trust instrument or relevant excerpts;
2. Receive an annual accounting of trust assets, income, and distributions;
3. Be informed of the trust's terms as they affect you;
4. Challenge trustee actions that violate the trust terms.

TRUST SUMMARY

The Trust holds the following types of assets: [DESCRIBE ASSET TYPES]

Your interest in the Trust is: [DESCRIBE BENEFICIARY'S INTEREST]

If you have any questions about your rights as a beneficiary or the administration of the Trust, please contact our office.

${sig()}

Enclosure: Relevant excerpts of Trust instrument (upon request)`;
    },
  },

  {
    id: 'letter_trust_accounting',
    label: 'Trust Accounting Cover Letter',
    description: 'Cover letter transmitting annual or final trust accounting to beneficiaries',
    generate(adminData, matterData) {
      const { decedentName, representativeName } = matterData;
      return `${todayLong()}

${firmHeader()}

[BENEFICIARY NAME]
[BENEFICIARY ADDRESS]

Re: [TRUST NAME] — Trust Accounting for Period [FROM DATE] to [TO DATE]

Dear [BENEFICIARY NAME]:

Enclosed herewith please find the [Annual / Final] Trust Accounting for the [TRUST NAME] for the period from [FROM DATE] through [TO DATE].

As Trustee of the Trust, ${representativeName} is required to provide an accounting to all trust beneficiaries. This accounting contains the following:

Schedule A — Trust property on hand at beginning of period
Schedule B — Receipts during the period
Schedule C — Disbursements during the period
Schedule D — Trust property on hand at end of period

SUMMARY

Beginning balance:            $[AMOUNT]
Total receipts during period: $[AMOUNT]
Total disbursements:          $[AMOUNT]
Ending balance:               $[AMOUNT]

Distributions to beneficiaries during this period: $[AMOUNT]

Please review the enclosed accounting carefully. If you have any questions or objections, please notify our office within thirty (30) days of receipt. After that period, the accounting will be deemed approved absent written objection.

${sig()}
On behalf of ${representativeName}, Trustee

Enclosures: Trust Accounting (Schedules A–D)`;
    },
  },

  {
    id: 'letter_trust_termination',
    label: 'Trust Termination Letter',
    description: 'Letter to beneficiaries confirming trust termination and final distribution',
    generate(adminData, matterData) {
      const { decedentName, representativeName } = matterData;
      return `${todayLong()}

${firmHeader()}

[BENEFICIARY NAME]
[BENEFICIARY ADDRESS]

Re: [TRUST NAME] — Final Accounting and Termination of Trust

Dear [BENEFICIARY NAME]:

We are pleased to advise you that the administration of the [TRUST NAME] is now complete, and the Trust is ready to be terminated.

Enclosed herewith please find:
1. The Final Accounting of the Trust (Schedules A through D)
2. A check or asset transfer representing your final distribution

FINAL DISTRIBUTION

Your share of the trust estate as calculated in the Final Accounting is: $[AMOUNT] [or describe asset].

Upon distribution of all trust assets, ${representativeName} will be discharged from the duties of Trustee, and the Trust will be terminated pursuant to its terms.

Please sign and return the enclosed Receipt, Release, and Refunding Agreement to acknowledge receipt of your distribution and to release the Trustee from any further liability in connection with the administration of the Trust.

It has been our privilege to assist in the administration of this trust.

${sig()}
On behalf of ${representativeName}, Trustee

Enclosures: Final Accounting (Schedules A–D)
            Receipt, Release, and Refunding Agreement
            Distribution check or transfer documentation
            Self-addressed stamped envelope`;
    },
  },
];

module.exports = { LETTER_TEMPLATES };
