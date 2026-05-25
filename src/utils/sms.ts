import axios from "axios";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const API_KEY = process.env.SMS_API_KEY;
const SENDER_ID = process.env.SMS_SENDER_ID;
const WELCOME_TEMPLATE_ID = process.env.SMS_WELCOME_TEMPLATE_ID;
const FORGOT_PIN_TEMPLATE_ID = process.env.SMS_FORGOT_PIN_TEMPLATE_ID;
const SMS_URL = "https://sms.promptbulksms.com/api/smsapi";

export const sendWelcomeSMS = async (name: string, phoneNumber: string, pin: string) => {
  try {
    if (!API_KEY || !SENDER_ID || !WELCOME_TEMPLATE_ID) {
      console.error("SMS configuration missing in environment variables");
      return null;
    }

    let message = `Congratulations!

Dear ${name}

Warm welcome to CNI !

Your application has been approved successfully.

Login Details : CNI Business Forum Application

Username: ${phoneNumber}

Password: ${pin}

 Please log in and change your password after first login for security.

CNI wishes you a successful journey ahead!

PROMPT`;

    const response = await axios.get(SMS_URL, {
      params: {
        key: API_KEY,
        route: 1,
        sender: SENDER_ID,
        number: phoneNumber,
        sms: message,
        templateid: WELCOME_TEMPLATE_ID
      }
    });

    console.log("SMS Response:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending SMS:", error);
    return null;
  }
};

export const sendOTPSMS = async (phoneNumber: string, otp: string, expiryMinutes: number = 5) => {
  try {
    if (!API_KEY || !SENDER_ID || !FORGOT_PIN_TEMPLATE_ID) {
      console.error("SMS configuration missing in environment variables");
      return null;
    }

    let message = `Dear CNI Member,

Your OTP to reset your CNI Business Forum Application is ${otp}.

Valid for ${expiryMinutes} minutes.

Do not share it with anyone.

CNI - PROMPT`;

    const response = await axios.get(SMS_URL, {
      params: {
        key: API_KEY,
        route: 1,
        sender: SENDER_ID,
        number: phoneNumber,
        sms: message,
        templateid: FORGOT_PIN_TEMPLATE_ID
      }
    });

    console.log("OTP SMS Response:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending OTP SMS:", error);
    return null;
  }
};
