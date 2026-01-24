import { Injectable, Logger } from "@nestjs/common";
import { GoogleGenerativeAI } from "@google/generative-ai";

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        "GEMINI_API_KEY not found. AI matching will be disabled.",
      );
    } else {
      this.genAI = new GoogleGenerativeAI(apiKey);
    }
  }

  async getMatchingRecommendations(
    requestData: any,
    candidateNannies: any[],
    historicalData: any[],
  ): Promise<Map<string, number>> {
    if (!this.genAI) {
      this.logger.warn("Gemini API not configured. Returning default scores.");
      return new Map();
    }

    try {
      const model = this.genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
      });

      const prompt = `
You are an AI matching assistant for a childcare platform. Analyze the following data and provide AI-based scoring for each nanny candidate.

REQUEST DETAILS:
- Required Skills: ${JSON.stringify(requestData.required_skills)}
- Children Ages: ${JSON.stringify(requestData.children_ages)}
- Special Requirements: ${requestData.special_requirements || "None"}
- Duration: ${requestData.duration_hours} hours

CANDIDATE NANNIES:
${candidateNannies
  .map(
    (n, i) => `
Nanny ${i + 1} (ID: ${n.id}):
- Skills: ${JSON.stringify(n.skills)}
- Experience: ${n.experience_years} years
- Hourly Rate: $${n.hourly_rate}
- Distance: ${n.distance?.toFixed(2)} km
- Acceptance Rate: ${n.acceptance_rate}%
`,
  )
  .join("\n")}

HISTORICAL SUCCESSFUL MATCHES (for learning):
${historicalData
  .slice(0, 10)
  .map(
    (h) => `
- Request Skills: ${JSON.stringify(h.request_skills)} → Matched with Nanny (Experience: ${h.nanny_experience} years, Skills: ${JSON.stringify(h.nanny_skills)}) → Success: ${h.was_successful}
`,
  )
  .join("\n")}

Based on the historical data patterns and the current request, provide an AI score (0-100) for each nanny. Consider:
1. Skill match quality (not just presence, but relevance)
2. Experience level appropriateness for the children's ages
3. Historical patterns of successful matches
4. Balance between quality and affordability

Respond ONLY with a JSON object mapping nanny IDs to scores:
{"nannyId1": score1, "nannyId2": score2, ...}
`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Extract JSON from response
      const jsonMatch = text.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const scores = JSON.parse(jsonMatch[0]);
        return new Map(Object.entries(scores).map(([k, v]) => [k, Number(v)]));
      }

      this.logger.warn("Could not parse AI response. Returning empty scores.");
      return new Map();
    } catch (error) {
      this.logger.error(`AI matching error: ${error.message}`);
      return new Map();
    }
  }

  async chatWithAi(message: string): Promise<string> {
    if (!this.genAI) {
      return "I'm sorry, but I'm not currently connected to my AI brain. Please try again later.";
    }

    try {
      const model = this.genAI.getGenerativeModel({
        model: "gemini-pro-latest",
      });

      const systemPrompt = `
You are the intelligent assistant for "Care Connect", a platform connecting parents with qualified nannies.
Your role is to help users (parents, nannies, and admins) understand the app, its features, and how to use it.

APP OVERVIEW:
Care Connect is a comprehensive childcare platform.
- Parents can find nannies, post jobs, and make bookings.
- Nannies can find work, manage their availability, and get paid.
- Admins oversee the system.

KEY FEATURES:
1.  **Authentication**: Email/Password and Google OAuth.
2.  **Profiles**: Detailed profiles for parents and nannies (skills, experience, rates).
3.  **Matching**: Smart algorithm matches parents with nannies based on location, skills, and preferences.
4.  **Booking**: Direct booking or auto-matching. Statuses: Requested, Confirmed, In Progress, Completed, Cancelled.
5.  **Chat**: Real-time messaging between parents and nannies after booking.
6.  **Reviews**: 5-star rating system with comments.
7.  **Location**: Geocoding and distance-based search.

USER ROLES:
- **Parent**: Creates service requests, books nannies.
- **Nanny**: Accepts assignments, manages profile.
- **Admin**: Verifies users, manages disputes.

DATA MODEL SUMMARY:
- Users, Profiles, NannyDetails, ServiceRequests, Assignments, Bookings, Chats, Messages, Reviews.

GUIDELINES:
- Be helpful, polite, and professional.
- Keep answers concise but informative.
- If you don't know the answer, say so. Do not hallucinate features.
- If asked about technical details (database, code), explain them in a user-friendly way if relevant, or politely decline if it's too internal.
- Focus on explaining *how* to use the app.

User Question: ${message}
`;

      const result = await model.generateContent(systemPrompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      this.logger.error(`AI chat error: ${error.message}`);
      return "I'm having trouble processing your request right now. Please try again.";
    }
  }
}
