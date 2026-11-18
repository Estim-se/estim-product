// Starting estimates are editable; they never generate an AI draft.
export const electricianMoments = [
  { name: 'Byte av vägguttag', unit: 'st', hours_per_unit: 0.5, material_per_unit_ex_vat: 95 },
  { name: 'Byte av strömbrytare', unit: 'st', hours_per_unit: 0.5, material_per_unit_ex_vat: 120 },
  { name: 'Installation av dimmer', unit: 'st', hours_per_unit: 0.75, material_per_unit_ex_vat: 450 },
  { name: 'Montering av taklampa', unit: 'st', hours_per_unit: 0.75, material_per_unit_ex_vat: 50 },
  { name: 'Installation av spotlight', unit: 'st', hours_per_unit: 1, material_per_unit_ex_vat: 250 },
  { name: 'Kabeldragning', unit: 'm', hours_per_unit: 0.1, material_per_unit_ex_vat: 25 },
  { name: 'Felsökning', unit: 'h', hours_per_unit: 1, material_per_unit_ex_vat: 0 },
  { name: 'Installation av jordfelsbrytare', unit: 'st', hours_per_unit: 2, material_per_unit_ex_vat: 850 },
  { name: 'Installation av laddbox', unit: 'st', hours_per_unit: 4, material_per_unit_ex_vat: 6500 },
  { name: 'Anslutning av spis', unit: 'st', hours_per_unit: 1, material_per_unit_ex_vat: 150 },
].map(moment => ({ ...moment, role: 'elektriker', rot_eligible: true, active: true }));