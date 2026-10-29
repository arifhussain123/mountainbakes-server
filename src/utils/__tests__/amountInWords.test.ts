import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rupeesInWords } from '../amountInWords';

test('rupees in words on the crore / lakh scale, with paisa', () => {
  assert.equal(rupeesInWords(0), 'Rupees Zero Only');
  assert.equal(rupeesInWords(640), 'Rupees Six Hundred Forty Only');
  assert.equal(rupeesInWords(45000), 'Rupees Forty-Five Thousand Only');
  assert.equal(rupeesInWords(125430), 'Rupees One Lakh Twenty-Five Thousand Four Hundred Thirty Only');
  assert.equal(rupeesInWords(35531372.25), 'Rupees Three Crore Fifty-Five Lakh Thirty-One Thousand Three Hundred Seventy-Two and Twenty-Five Paisa Only');
  assert.equal(rupeesInWords(1250.5), 'Rupees One Thousand Two Hundred Fifty and Fifty Paisa Only');
  assert.equal(rupeesInWords(100000), 'Rupees One Lakh Only');
  assert.equal(rupeesInWords(-23000), 'Minus Rupees Twenty-Three Thousand Only');
  assert.equal(rupeesInWords(0.1 + 0.2), 'Rupees Zero and Thirty Paisa Only');
});
