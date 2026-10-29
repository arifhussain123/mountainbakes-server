const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–99 in words: 45 → "Forty-Five". */
function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const unit = n % 10;
  return TENS[Math.floor(n / 10)]! + (unit ? `-${ONES[unit]}` : '');
}

/** 0–999 in words: 305 → "Three Hundred Five". */
function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/**
 * A whole number in words on the Pakistani scale — crore, lakh, thousand —
 * as amounts are written on a cheque: 1,25,430 → "One Lakh Twenty-Five
 * Thousand Four Hundred Thirty".
 */
function wholeInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${wholeInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/**
 * Rupees and paisa in words for a statement: 45000 → "Rupees Forty-Five
 * Thousand Only", 1250.5 → "Rupees One Thousand Two Hundred Fifty and Fifty
 * Paisa Only". A negative amount (a branch in credit) reads "Minus Rupees …".
 */
export function rupeesInWords(amount: number): string {
  const paisaTotal = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(paisaTotal / 100);
  const paisa = paisaTotal % 100;
  const words = `Rupees ${wholeInWords(rupees)}${paisa ? ` and ${belowHundred(paisa)} Paisa` : ''} Only`;
  return amount < 0 && paisaTotal > 0 ? `Minus ${words}` : words;
}
