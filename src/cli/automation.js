export function hasUsableAutomation(automationJson) {
  if (!automationJson) {
    return false;
  }
  try {
    const automation = JSON.parse(automationJson);
    return Boolean(
      typeof automation?.kind === "string" &&
      automation.kind.trim() &&
      typeof automation?.prompt === "string" &&
      automation.prompt.trim(),
    );
  } catch {
    return false;
  }
}
