// estim Samtal is its own module behind the flag SAMTAL (off unless set to 1).
export const samtalEnabled = () => process.env['SAMTAL'] === '1';
