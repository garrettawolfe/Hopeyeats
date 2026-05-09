import { describe, it, expect } from "vitest";
import { buildSmsEmail, SMS_GATEWAYS } from "@/lib/notifications";

describe("buildSmsEmail", () => {
  it("returns empty string for unknown carrier", () => {
    expect(buildSmsEmail("2125551234", "unknowncarrier")).toBe("");
  });

  it("formats Verizon SMS gateway correctly", () => {
    expect(buildSmsEmail("2125551234", "verizon")).toBe("2125551234@vtext.com");
  });

  it("formats AT&T SMS gateway correctly", () => {
    expect(buildSmsEmail("2125551234", "att")).toBe("2125551234@txt.att.net");
  });

  it("formats T-Mobile SMS gateway correctly", () => {
    expect(buildSmsEmail("2125551234", "tmobile")).toBe("2125551234@tmomail.net");
  });

  it("strips non-digit characters from phone number", () => {
    expect(buildSmsEmail("(212) 555-1234", "verizon")).toBe("2125551234@vtext.com");
    expect(buildSmsEmail("+1-212-555-1234", "att")).toBe("12125551234@txt.att.net");
  });

  it("returns empty string for empty phone number", () => {
    expect(buildSmsEmail("", "verizon")).toBe("");
  });

  it("SMS_GATEWAYS covers all major carriers", () => {
    const expected = ["verizon", "att", "tmobile", "sprint", "uscellular", "cricket", "boost", "metro"];
    expected.forEach((carrier) => {
      expect(SMS_GATEWAYS[carrier], `${carrier} in SMS_GATEWAYS`).toBeTruthy();
    });
  });
});
