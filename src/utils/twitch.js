function normalizeTwitchLogin(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/^@+/, "").toLowerCase();
}

function formatApprovalStatus(link) {
  return link.approved ? "approved" : "pending approval";
}

module.exports = {
  normalizeTwitchLogin,
  formatApprovalStatus,
};
