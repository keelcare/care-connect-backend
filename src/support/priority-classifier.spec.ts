import { classifyTicketPriority } from "./priority-classifier";

describe("classifyTicketPriority", () => {
  describe("Critical priority detection", () => {
    it("classifies emergency and danger keywords as critical", () => {
      expect(
        classifyTicketPriority(
          "Emergency! Child needs help",
          "There is immediate danger at home",
          "other",
        ),
      ).toBe("critical");
      expect(
        classifyTicketPriority("SOS", "Please call someone immediately", "booking"),
      ).toBe("critical");
      expect(
        classifyTicketPriority(
          "Unsafe environment",
          "The caregiver created a dangerous situation",
          "grievance",
        ),
      ).toBe("critical");
    });

    it("classifies medical emergencies and injuries as critical", () => {
      expect(
        classifyTicketPriority(
          "Caregiver injured child",
          "My baby is bleeding and we called an ambulance",
          "grievance",
        ),
      ).toBe("critical");
      expect(
        classifyTicketPriority(
          "Child fell down stairs",
          "Child is unconscious after falling",
          "booking",
        ),
      ).toBe("critical");
      expect(
        classifyTicketPriority(
          "Hospital visit required",
          "Caregiver burns on baby during boiling water handling",
          "grievance",
        ),
      ).toBe("critical");
    });

    it("classifies abuse, violence, physical assault, and weapons as critical", () => {
      expect(
        classifyTicketPriority(
          "Physical abuse report",
          "Caregiver slapped my child across the face",
          "grievance",
        ),
      ).toBe("critical");
      expect(
        classifyTicketPriority(
          "Theft in house",
          "Nanny stole jewelry from the bedroom, police complaint filed",
          "grievance",
        ),
      ).toBe("critical");
      expect(
        classifyTicketPriority(
          "Sexual harassment",
          "Inappropriate touching occurred during session",
          "grievance",
        ),
      ).toBe("critical");
    });

    it("classifies intoxication on duty as critical", () => {
      expect(
        classifyTicketPriority(
          "Nanny intoxicated",
          "Caregiver arrived drunk and smelling of alcohol",
          "grievance",
        ),
      ).toBe("critical");
    });

    it("classifies ban appeals and account hacking as critical", () => {
      expect(
        classifyTicketPriority(
          "Ban appeal",
          "My account was banned unfairly, please review",
          "account",
        ),
      ).toBe("critical");
      expect(
        classifyTicketPriority(
          "Account hacked",
          "Someone unauthorized accessed my account",
          "account",
        ),
      ).toBe("critical");
    });
  });

  describe("High priority detection", () => {
    it("classifies nanny no-show / attendance breakdown as high", () => {
      expect(
        classifyTicketPriority(
          "Where is my nanny? (Booking #1234)",
          "I need help locating my assigned caregiver for booking #1234. They have not arrived / I am unable to reach them.",
          "booking",
        ),
      ).toBe("high");
      expect(
        classifyTicketPriority(
          "Nanny didn't arrive",
          "Caregiver never showed up and phone is switched off",
          "booking",
        ),
      ).toBe("high");
      expect(
        classifyTicketPriority(
          "Caregiver no-show",
          "The educator is 2 hours late and unreachable",
          "booking",
        ),
      ).toBe("high");
    });

    it("classifies child left alone or abandoned as high", () => {
      expect(
        classifyTicketPriority(
          "Nanny left early",
          "Caregiver walked out and left my child alone in the house",
          "booking",
        ),
      ).toBe("high");
    });

    it("classifies double charge and payment disputes as high", () => {
      expect(
        classifyTicketPriority(
          "Payment issue (Booking #1234)",
          "I was charged twice for booking #1234 and money was deducted twice.",
          "payment",
        ),
      ).toBe("high");
      expect(
        classifyTicketPriority(
          "Fraudulent transaction",
          "Unauthorized deduction of Rs 5000 on my card",
          "payment",
        ),
      ).toBe("high");
      expect(
        classifyTicketPriority(
          "Refund stuck",
          "My refund was not received for cancelled booking",
          "payment",
        ),
      ).toBe("high");
    });

    it("classifies severe behavioral misconduct and grievances as high", () => {
      expect(
        classifyTicketPriority(
          "Nanny rude and shouting",
          "Caregiver was screaming at family members and behaving unprofessionally",
          "grievance",
        ),
      ).toBe("high");
      // Even without specific keywords, category grievance defaults to high
      expect(
        classifyTicketPriority(
          "Concern regarding nanny",
          "I would like to raise a query about caregiver conduct",
          "grievance",
        ),
      ).toBe("high");
    });
  });

  describe("Low priority detection", () => {
    it("classifies compliments and feedback as low", () => {
      expect(
        classifyTicketPriority(
          "Great experience!",
          "Just wanted to say thank you for the wonderful nanny, appreciate it.",
          "other",
        ),
      ).toBe("low");
      expect(
        classifyTicketPriority(
          "App suggestion",
          "Feature request: would love a dark mode option",
          "technical",
        ),
      ).toBe("low");
    });

    it("classifies general FAQs and questions as low", () => {
      expect(
        classifyTicketPriority(
          "General question",
          "How does the matching process work?",
          "other",
        ),
      ).toBe("low");
      expect(
        classifyTicketPriority(
          "Curious about special needs",
          "Just wondering what certifications the teachers hold",
          "other",
        ),
      ).toBe("low");
    });
  });

  describe("Medium priority (Default) fallback", () => {
    it("defaults standard booking scheduling queries to medium", () => {
      expect(
        classifyTicketPriority(
          "Help with scheduling (Booking #1234)",
          "I need help changing or rescheduling booking #1234.",
          "booking",
        ),
      ).toBe("medium");
      expect(
        classifyTicketPriority(
          "Question about caregiver match",
          "I have a question about the caregiver assignment for booking #1234.",
          "booking",
        ),
      ).toBe("medium");
    });

    it("defaults regular billing/invoice questions to medium", () => {
      expect(
        classifyTicketPriority(
          "Tax invoice needed",
          "Please share the GST receipt for last month's sessions",
          "payment",
        ),
      ).toBe("medium");
    });

    it("defaults regular app technical bugs to medium", () => {
      expect(
        classifyTicketPriority(
          "UI glitch on profile",
          "The profile photo takes a long time to load on the settings tab",
          "technical",
        ),
      ).toBe("medium");
    });

    it("handles empty or null inputs gracefully", () => {
      expect(classifyTicketPriority("", "", "")).toBe("medium");
      expect(classifyTicketPriority(null, null, null)).toBe("medium");
      expect(classifyTicketPriority(undefined, undefined, undefined)).toBe("medium");
    });
  });

  describe("Precedence and safety guardrails", () => {
    it("does not downgrade critical issues even if polite or feedback words are present", () => {
      expect(
        classifyTicketPriority(
          "Feedback: Emergency safety concern",
          "Thank you for the service, but the caregiver got drunk and hit my child.",
          "grievance",
        ),
      ).toBe("critical");
    });

    it("does not downgrade high issues even if feedback words are present", () => {
      expect(
        classifyTicketPriority(
          "Feedback: Nanny never showed up",
          "Thanks, but where is my nanny for today's session?",
          "booking",
        ),
      ).toBe("high");
    });
  });
});
