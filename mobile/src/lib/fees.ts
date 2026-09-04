export const formatVnd = (amount: number): string => `${new Intl.NumberFormat('vi-VN').format(amount)}đ`;

export const formatParticipationFee = (amount: number): string => amount === 0 ? 'Miễn phí' : `${formatVnd(amount)} / người`;

export const parseVndInput = (value: string): number => {
  const digits = value.replace(/\D/g, '');
  return digits ? Math.min(Number(digits), 10_000_000) : 0;
};
