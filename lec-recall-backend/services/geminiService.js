const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

async function detectQuestion(transcriptText) {
  const prompt = `The user is speaking to an audience. 

You must determine whether or not what the user says contains a question for the audience.

Keep in mind this is transcribed text, and could have errors. 
If there are multiple questions, say only the first complete one.

Shorten question such that it is in a CONCISE quiz-format. DO NOT add any additional information.

Transcript: "${transcriptText}"

Response format:
{
  "hasQuestion": boolean,
  "question": "extracted question or null"
}`;

  try {
    const response = await axios.post(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 200
      }
    });

    const result = response.data.candidates[0].content.parts[0].text;
    console.log('🤖 Gemini question detection response:', result);
    
    // Try to parse JSON response
    try {
      return JSON.parse(result);
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', parseError);
      // Fallback: check if response contains a question mark
      const hasQuestion = result.toLowerCase().includes('hasquestion') && 
                         result.toLowerCase().includes('true');
      const questionMatch = result.match(/"question":\s*"([^"]+)"/);
      const question = questionMatch ? questionMatch[1] : null;
      
      return { hasQuestion, question };
    }
  } catch (error) {
    console.error('❌ Gemini question detection error:', error.response?.data || error.message);
    return { hasQuestion: false, question: null };
  }
}

async function generateQuiz(question) {
  const prompt = `The user will give you a question. 
  
Generate 4 SHORT multiple choice answers for the question.
Each answer must be concise so they can be read fast.

Only 1 of them may be correct.
3 of them must be plausible, but incorrect.

The answers should be DIFFICULT and they need to make people think.

Question: "${question}"

Response format:
{
  "optionA": "answer text",
  "optionB": "answer text", 
  "optionC": "answer text",
  "optionD": "answer text",
  "correctAnswer": "A" // or B, C, D
}`;

  try {
    const response = await axios.post(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 300
      }
    });

    const result = response.data.candidates[0].content.parts[0].text;
    console.log('🤖 Gemini quiz generation response:', result);
    
    // Try to parse JSON response
    try {
      return JSON.parse(result);
    } catch (parseError) {
      console.error('Failed to parse Gemini quiz response as JSON:', parseError);
      // Fallback: extract options using regex
      const optionAMatch = result.match(/"optionA":\s*"([^"]+)"/);
      const optionBMatch = result.match(/"optionB":\s*"([^"]+)"/);
      const optionCMatch = result.match(/"optionC":\s*"([^"]+)"/);
      const optionDMatch = result.match(/"optionD":\s*"([^"]+)"/);
      const correctMatch = result.match(/"correctAnswer":\s*"([ABCD])"/);
      
      if (optionAMatch && optionBMatch && optionCMatch && optionDMatch && correctMatch) {
        return {
          optionA: optionAMatch[1],
          optionB: optionBMatch[1],
          optionC: optionCMatch[1],
          optionD: optionDMatch[1],
          correctAnswer: correctMatch[1]
        };
      }
      
      return null;
    }
  } catch (error) {
    console.error('❌ Gemini quiz generation error:', error.response?.data || error.message);
    return null;
  }
}

async function generateSummary(transcriptText) {
  const prompt = `Summarize this lecture transcript in a clear, organized way. Include:
1. Main topics covered
2. Key concepts explained
3. Important points emphasized

Transcript: "${transcriptText}"

Provide a concise but comprehensive summary suitable for student review.`;

  try {
    const response = await axios.post(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 500
      }
    });

    const result = response.data.candidates[0].content.parts[0].text;
    console.log('🤖 Gemini summary generated');
    return result;
  } catch (error) {
    console.error('❌ Gemini summary generation error:', error.response?.data || error.message);
    return 'Unable to generate summary at this time.';
  }
}

async function generateStudentReview(missedQuestions, summary) {
  const prompt = `Based on the questions the student got wrong and the lecture summary, provide personalized study recommendations.

Missed Questions: ${JSON.stringify(missedQuestions)}
Lecture Summary: "${summary}"

Provide 3-5 specific topics the student should review.`;

  try {
    const response = await axios.post(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 400
      }
    });

    const result = response.data.candidates[0].content.parts[0].text;
    console.log('🤖 Gemini student review generated');
    return result;
  } catch (error) {
    console.error('❌ Gemini student review error:', error.response?.data || error.message);
    return 'Unable to generate personalized review at this time.';
  }
}

module.exports = { 
  detectQuestion, 
  generateQuiz, 
  generateSummary, 
  generateStudentReview 
};
