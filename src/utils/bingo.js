export const generateBoard = () => {
  const numbers = Array.from({ length: 100 }, (_, i) => i + 1);
  // Fisher-Yates shuffle
  for (let i = numbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }
  return numbers.slice(0, 25);
};

export const checkBingo = (board, markedNumbers) => {
  let lines = 0;
  
  // Create 2D array representation
  const grid = [];
  for (let i = 0; i < 5; i++) {
    grid.push(board.slice(i * 5, (i + 1) * 5));
  }

  // Check rows
  for (let i = 0; i < 5; i++) {
    if (grid[i].every(num => markedNumbers.includes(num))) {
      lines++;
    }
  }

  // Check columns
  for (let j = 0; j < 5; j++) {
    let colMatch = true;
    for (let i = 0; i < 5; i++) {
      if (!markedNumbers.includes(grid[i][j])) {
        colMatch = false;
        break;
      }
    }
    if (colMatch) lines++;
  }

  // Check diagonals
  let diag1Match = true;
  let diag2Match = true;
  for (let i = 0; i < 5; i++) {
    if (!markedNumbers.includes(grid[i][i])) diag1Match = false;
    if (!markedNumbers.includes(grid[i][4 - i])) diag2Match = false;
  }
  if (diag1Match) lines++;
  if (diag2Match) lines++;

  return lines;
};
