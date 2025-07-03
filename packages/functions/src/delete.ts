import { Resource } from "sst";
import { Util } from "@notes/core/util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({});

export const main = Util.handler(async (event) => {
  const userId = event.requestContext.authorizer?.iam.cognitoIdentity.identityId;
  const noteId = event?.pathParameters?.id;

  // First, retrieve the note to check if it has an attachment
  const getParams = {
    TableName: Resource.Notes.name,
    Key: {
      userId,
      noteId,
    },
  };

  const result = await dynamoDb.send(new GetCommand(getParams));
  
  // If note has an attachment, delete it from S3
  if (result.Item && result.Item.attachment) {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: Resource.Uploads.name,
        Key: result.Item.attachment,
      }));
    } catch (error) {
      console.error("Failed to delete S3 attachment:", error);
      // Continue with note deletion even if S3 deletion fails
    }
  }

  // Delete the note from DynamoDB
  const deleteParams = {
    TableName: Resource.Notes.name,
    Key: {
      userId,
      noteId,
    },
  };

  await dynamoDb.send(new DeleteCommand(deleteParams));

  return JSON.stringify({ status: true });
});
