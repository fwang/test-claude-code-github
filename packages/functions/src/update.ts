import { Resource } from "sst";
import { Util } from "@notes/core/util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand, DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({});

export const main = Util.handler(async (event) => {
  const data = JSON.parse(event.body || "{}");
  const userId = event.requestContext.authorizer?.iam.cognitoIdentity.identityId;
  const noteId = event?.pathParameters?.id;

  // First, retrieve the existing note to check current attachment
  const getParams = {
    TableName: Resource.Notes.name,
    Key: {
      userId,
      noteId,
    },
  };

  const result = await dynamoDb.send(new GetCommand(getParams));
  
  // If the note exists and has an attachment, and the attachment is being changed/removed
  if (result.Item && result.Item.attachment && result.Item.attachment !== data.attachment) {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: Resource.Uploads.name,
        Key: result.Item.attachment,
      }));
    } catch (error) {
      console.error("Failed to delete old S3 attachment:", error);
      // Continue with note update even if S3 deletion fails
    }
  }

  // Update the note with new data
  const updateParams = {
    TableName: Resource.Notes.name,
    Key: {
      userId,
      noteId,
    },
    UpdateExpression: "SET content = :content, attachment = :attachment",
    ExpressionAttributeValues: {
      ":attachment": data.attachment || null,
      ":content": data.content || null,
    },
  };

  await dynamoDb.send(new UpdateCommand(updateParams));

  return JSON.stringify({ status: true });
});
